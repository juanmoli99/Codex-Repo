import { createHash, randomUUID } from 'node:crypto';
import type {
  PositionVersionMigration,
  SignalProposal,
  StrategyContext,
  StrategyDefinition,
  StrategyEvaluation,
  StrategySignal,
} from './types.js';

export interface StrategyPersistence {
  saveSignal(signal: StrategySignal): Promise<void>;
  saveMigration(migration: PositionVersionMigration): Promise<void>;
  hasSignal?(deduplicationKey: string): Promise<boolean>;
  lastEntrySignalAt?(scope: {
    strategyId: string;
    strategyVersion: string;
    symbol: string;
  }): Promise<Date | undefined>;
  countActionableSignals?(scope: {
    strategyId: string;
    strategyVersion: string;
    from: Date;
    to: Date;
  }): Promise<number>;
}

interface EngineOptions {
  readonly configurationSnapshot: Readonly<Record<string, unknown>>;
  readonly persistence?: StrategyPersistence;
  readonly idFactory?: () => string;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dedupeKey(
  strategy: StrategyDefinition,
  context: StrategyContext,
  proposal: SignalProposal,
) {
  return createHash('sha256')
    .update(
      [
        strategy.id,
        strategy.version,
        context.symbol,
        proposal.type,
        context.timestamp.toISOString(),
      ].join('|'),
    )
    .digest('hex');
}

export class StrategyEngine {
  private readonly definitions = new Map<string, Map<string, StrategyDefinition>>();
  private readonly seen = new Set<string>();
  private readonly lastSignalAt = new Map<string, number>();
  private readonly dailySignalCounts = new Map<string, number>();
  private readonly idFactory: () => string;

  public constructor(private readonly options: EngineOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public register(definition: StrategyDefinition): void {
    const versions = this.definitions.get(definition.id) ?? new Map<string, StrategyDefinition>();
    if (versions.has(definition.version))
      throw new Error(
        `Strategy version already registered: ${definition.id}@${definition.version}`,
      );
    if (
      definition.lifecycle === 'ACTIVE' &&
      [...versions.values()].some((candidate) => candidate.lifecycle === 'ACTIVE')
    )
      throw new Error(`Strategy ${definition.id} already has an ACTIVE version`);
    versions.set(definition.version, definition);
    this.definitions.set(definition.id, versions);
  }

  public getActive(): readonly StrategyDefinition[] {
    return [...this.definitions.values()].flatMap((versions) =>
      [...versions.values()].filter((definition) => definition.lifecycle === 'ACTIVE'),
    );
  }

  public getForPosition(strategyId: string, version: string): StrategyDefinition | undefined {
    const definition = this.definitions.get(strategyId)?.get(version);
    return definition?.lifecycle === 'DISABLED' ? undefined : definition;
  }

  public async evaluate(
    definition: StrategyDefinition,
    context: StrategyContext,
  ): Promise<StrategyEvaluation> {
    if (!context.hasOpenPosition && definition.lifecycle !== 'ACTIVE')
      return this.reject(
        definition,
        context,
        'STRATEGY_NOT_ACTIVE',
        'Only ACTIVE versions may enter',
      );
    if (context.timeframe !== definition.timeframe)
      return this.reject(
        definition,
        context,
        'TIMEFRAME_MISMATCH',
        `Strategy requires ${definition.timeframe}, received ${context.timeframe}`,
      );
    if (
      context.hasOpenPosition &&
      context.positionStrategyVersion !== undefined &&
      context.positionStrategyVersion !== definition.version
    )
      return this.reject(
        definition,
        context,
        'POSITION_VERSION_MISMATCH',
        'Existing positions remain bound to their originating version',
      );

    const proposal = definition.evaluate(context);
    if (
      (proposal.confidence !== undefined &&
        (!Number.isFinite(proposal.confidence) ||
          proposal.confidence < 0 ||
          proposal.confidence > 1)) ||
      (proposal.expectedEdgeBps !== undefined && !Number.isFinite(proposal.expectedEdgeBps))
    )
      return this.reject(
        definition,
        context,
        'ABNORMAL_OUTPUT',
        'Strategy emitted invalid metrics',
      );
    if (proposal.expiresAt.getTime() <= context.timestamp.getTime())
      return this.reject(
        definition,
        context,
        'SIGNAL_EXPIRED',
        'Strategy emitted an expired signal',
      );

    // HOLD is an observation, not an actionable signal. It must not consume dedupe, cooldown,
    // signal allowance, persistence, or trade allowance.
    if (proposal.type === 'HOLD') return {};

    const key = dedupeKey(definition, context, proposal);
    if (this.seen.has(key) || (await this.options.persistence?.hasSignal?.(key)) === true)
      return this.reject(
        definition,
        context,
        'DUPLICATE_SIGNAL',
        'Identical signal already processed',
      );
    const scope = `${definition.id}|${definition.version}|${context.symbol}`;
    const persistedPrevious = await this.options.persistence?.lastEntrySignalAt?.({
      strategyId: definition.id,
      strategyVersion: definition.version,
      symbol: context.symbol,
    });
    const previous = Math.max(this.lastSignalAt.get(scope) ?? 0, persistedPrevious?.getTime() ?? 0);
    const entrySignal = proposal.type === 'BUY';
    if (
      entrySignal &&
      previous > 0 &&
      context.timestamp.getTime() - previous < definition.cooldownMs
    )
      return this.reject(
        definition,
        context,
        'COOLDOWN_ACTIVE',
        'Strategy signal cooldown is active',
      );
    const countKey = `${definition.id}|${definition.version}|${dayKey(context.timestamp)}`;
    const from = new Date(context.timestamp);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 86_400_000);
    const persistedCount =
      (await this.options.persistence?.countActionableSignals?.({
        strategyId: definition.id,
        strategyVersion: definition.version,
        from,
        to,
      })) ?? 0;
    const count = Math.max(this.dailySignalCounts.get(countKey) ?? 0, persistedCount);
    if (count >= definition.maximumSignalsPerDay)
      return this.reject(
        definition,
        context,
        'DAILY_SIGNAL_LIMIT',
        'Daily strategy signal limit reached',
      );

    const parametersSnapshot = {
      ...definition.parameters,
      ...(definition.assetOverrides?.[context.symbol] ?? {}),
    };
    const signal: StrategySignal = {
      id: this.idFactory(),
      timestamp: new Date(context.timestamp),
      symbol: context.symbol,
      strategyId: definition.id,
      strategyVersion: definition.version,
      configurationVersion: definition.configurationVersion,
      deploymentId: definition.deploymentId,
      type: proposal.type,
      reason: proposal.reason,
      ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }),
      ...(proposal.expectedEdgeBps === undefined
        ? {}
        : { expectedEdgeBps: proposal.expectedEdgeBps }),
      expiresAt: new Date(proposal.expiresAt),
      parametersSnapshot: Object.freeze({ ...parametersSnapshot }),
      configurationSnapshot: Object.freeze({
        ...this.options.configurationSnapshot,
        signalPrice: context.price,
        signalTimeframe: context.timeframe,
      }),
      deduplicationKey: key,
    };
    this.seen.add(key);
    if (entrySignal) this.lastSignalAt.set(scope, context.timestamp.getTime());
    this.dailySignalCounts.set(countKey, count + 1);
    await this.options.persistence?.saveSignal(signal);
    return { signal };
  }

  public async migratePosition(input: {
    symbol: string;
    strategyId: string;
    fromVersion: string;
    toVersion: string;
    reason: string;
    approvedBy: string;
    migratedAt: Date;
  }): Promise<PositionVersionMigration> {
    const versions = this.definitions.get(input.strategyId);
    if (!versions?.has(input.fromVersion) || !versions.has(input.toVersion))
      throw new Error('Both strategy versions must be registered before migration');
    const migration = { id: this.idFactory(), ...input };
    await this.options.persistence?.saveMigration(migration);
    return migration;
  }

  private reject(
    definition: StrategyDefinition,
    context: StrategyContext,
    code: NonNullable<StrategyEvaluation['rejection']>['code'],
    detail: string,
  ): StrategyEvaluation {
    return {
      rejection: {
        strategyId: definition.id,
        strategyVersion: definition.version,
        symbol: context.symbol,
        code,
        detail,
      },
    };
  }
}

export function selectStrategyForRegime(
  definitions: readonly StrategyDefinition[],
  context: StrategyContext,
): StrategyDefinition | undefined {
  if (context.eventRisk === 'BLOCKED') return undefined;
  const adx = context.indicators.adx;
  const volatility = context.indicators.volatility;
  if (adx === null || adx === undefined || volatility === null || volatility === undefined)
    return undefined;
  const preferred =
    volatility > 0.6
      ? undefined
      : adx >= 25
        ? context.indicators['volume.ratio'] !== undefined &&
          (context.indicators['volume.ratio'] ?? 0) >= 1.5
          ? 'volatility-breakout'
          : 'trend-following'
        : 'mean-reversion';
  return definitions.find(
    (definition) => definition.id === preferred && definition.lifecycle === 'ACTIVE',
  );
}
