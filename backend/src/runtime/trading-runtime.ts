import { createHash, randomUUID } from 'node:crypto';

import { Decimal } from 'decimal.js';
import type { Logger } from 'pino';

import type { Prisma } from '../generated/prisma/client.js';

import { measureExecutionQuality } from '../analytics/execution-quality.js';
import { CircuitBreaker } from '../alpaca/circuit-breaker.js';
import {
  AlpacaHttpClient,
  AlpacaUnknownOutcomeError,
  type BrokerRequestObservation,
} from '../alpaca/http-client.js';
import { PersistentRateBudget } from '../alpaca/persistent-rate-budget.js';
import { AlpacaTradingClient } from '../alpaca/trading-client.js';
import type { AlpacaAccount, AlpacaActivity, AlpacaOrder } from '../alpaca/types.js';
import {
  AlertService,
  TelegramAlertChannel,
  type AlertKind,
  type AlertSeverity,
} from '../alerts/service.js';
import {
  PrismaAlertRepository,
  RecordedAlertChannel,
  UnavailableAlertChannel,
} from '../alerts/prisma.js';
import { BacktestEngine, type BacktestResult } from '../backtesting/engine.js';
import type { AppConfig } from '../core/config.js';
import { AppError, InputValidationError } from '../core/errors.js';
import type { OperationalStateService } from '../core/operational-state.js';
import { ExecutionCoordinator } from '../concurrency/coordinator.js';
import { AlpacaCorporateActionsClient } from '../corporate-actions/client.js';
import {
  CorporateActionService,
  type CorporateAction,
  type CorporateActionType,
} from '../corporate-actions/service.js';
import type { DatabaseClient } from '../database/client.js';
import { PersistentLockService } from '../database/locks.js';
import { brokerStatusToOrderState } from '../execution/order-state-machine.js';
import type { OrderState } from '../execution/order-state-machine.js';
import { TradeExecutor, type TradeIntent } from '../execution/trade-executor.js';
import {
  adx,
  atr,
  averageVolume,
  bollingerBands,
  ema,
  rollingVolatility,
  rsi,
} from '../indicators/index.js';
import { MarketDataCache } from '../market-data/cache.js';
import { MarketCalendarService, marketLocalToUtc } from '../market-data/calendar.js';
import { AlpacaMarketDataClient } from '../market-data/client.js';
import { TradingHaltService } from '../market-data/halts.js';
import { AlpacaMarketStream } from '../market-data/stream-client.js';
import type { MarketBar, MarketDataValidationResult, MarketQuote } from '../market-data/types.js';
import { timeframeMilliseconds } from '../market-data/types.js';
import { MarketDataHealthService, MarketDataValidator } from '../market-data/validator.js';
import { buildPortfolioState } from '../portfolio/service.js';
import {
  ReconciliationService,
  type ReconciliationResult,
  type ReconciliationTrigger,
} from '../reconciliation/service.js';
import { RecoveryCoordinator } from '../recovery/coordinator.js';
import { AccountRestrictionGuard } from '../regulatory/account-restrictions.js';
import {
  createRiskConfigurationSnapshot,
  riskConfigurationSchema,
  type RiskConfigurationSnapshot,
} from '../risk/config.js';
import { PreTradeRiskGate, type RiskDecision } from '../risk/pre-trade.js';
import { sizePosition, type PositionSizingResult } from '../risk/position-sizing.js';
import { PersistentCircuitBreakerService } from '../safety/circuit-breakers.js';
import { OperationalSafetyService } from '../safety/service.js';
import { ScannerService, type ScanCandidate, type ScannerExecution } from '../scanner/service.js';
import {
  SchedulerService,
  type SchedulerExecution,
  type SchedulerSnapshot,
} from '../scheduler/service.js';
import { SchedulerWorker } from '../scheduler/worker.js';
import { StrategyEngine, selectStrategyForRegime } from '../strategies/engine.js';
import {
  createBreakoutStrategy,
  createMeanReversionStrategy,
  createTrendStrategy,
} from '../strategies/implementations.js';
import type { StrategyContext, StrategyDefinition, StrategySignal } from '../strategies/types.js';
import type { OperationsRuntime, RuntimeActionContext } from './types.js';
import {
  createBrokerRequestRecorder,
  loadSafetyState,
  PrismaCircuitBreakerRepository,
  PrismaSafetyRepository,
  PrismaTradeExecutionRepository,
} from './prisma-adapters.js';

interface ValidatedMarketData {
  readonly bars: readonly MarketBar[];
  readonly quote: MarketQuote;
  readonly validation: MarketDataValidationResult;
  readonly hasOpenPosition: boolean;
  readonly positionStrategyVersion?: string;
  readonly eventRisk: 'NONE' | 'ELEVATED' | 'BLOCKED';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function latest<T>(values: readonly T[], extractor: (value: T) => number | null): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const candidate = values.at(index);
    if (candidate === undefined) continue;
    const value = extractor(candidate);
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function marketDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function startOfMarketDay(instant: Date): Date {
  return marketLocalToUtc(marketDate(instant), '00:00');
}

function withinRiskSession(timestamp: Date, start: string, end: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? -1);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? -1);
  const parse = (value: string): number => {
    const [hours = '-1', minutes = '-1'] = value.split(':');
    return Number(hours) * 60 + Number(minutes);
  };
  const current = hour * 60 + minute;
  return current >= parse(start) && current <= parse(end);
}

function accountTradeable(account: AlpacaAccount): boolean {
  return (
    account.status === 'ACTIVE' &&
    !account.account_blocked &&
    !account.trading_blocked &&
    !account.trade_suspended_by_user
  );
}

export class TradingRuntime implements OperationsRuntime {
  private readonly instanceId = randomUUID();
  private readonly locks: PersistentLockService;
  private readonly coordinator: ExecutionCoordinator;
  private readonly persistentCircuits: PersistentCircuitBreakerService;
  private readonly safety: OperationalSafetyService;
  private readonly readTrading: AlpacaTradingClient;
  private readonly writeTrading: AlpacaTradingClient;
  private readonly marketData: AlpacaMarketDataClient;
  private readonly calendar: MarketCalendarService;
  private readonly corporateActions: AlpacaCorporateActionsClient;
  private readonly corporateActionService = new CorporateActionService();
  private readonly haltService = new TradingHaltService();
  private readonly marketHealth = new MarketDataHealthService();
  private readonly marketValidator = new MarketDataValidator();
  private readonly marketStream: AlpacaMarketStream;
  private readonly strategyEngine: StrategyEngine;
  private readonly scanner: ScannerService<ValidatedMarketData>;
  private readonly riskGate: PreTradeRiskGate;
  private readonly executor: TradeExecutor;
  private readonly reconciliation: ReconciliationService;
  private readonly recovery = new RecoveryCoordinator();
  private readonly scheduler: SchedulerService;
  private readonly schedulerWorker: SchedulerWorker;
  private readonly alerts: AlertService;
  private reconciliationTimer?: NodeJS.Timeout;
  private readinessTimer?: NodeJS.Timeout;
  private alertRetryTimer?: NodeJS.Timeout;
  private stopping = false;
  private readonly criticalOperations = new Set<Promise<unknown>>();

  private constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseClient,
    private readonly logger: Logger,
    private readonly operationalState: OperationalStateService,
    safety: OperationalSafetyService,
    schedulerSnapshot: SchedulerSnapshot,
  ) {
    this.safety = safety;
    const alertRepository = new PrismaAlertRepository(database);
    const primaryAlertChannel =
      config.alerts.telegramBotToken && config.alerts.telegramChatId
        ? new RecordedAlertChannel(
            database,
            new TelegramAlertChannel(config.alerts.telegramBotToken, config.alerts.telegramChatId),
          )
        : new UnavailableAlertChannel('telegram');
    this.alerts = new AlertService(
      alertRepository,
      primaryAlertChannel,
      new UnavailableAlertChannel('secondary'),
      {
        throttleMs: 5 * 60_000,
        maximumDeliveryAttempts: 8,
        retryBaseMs: 15_000,
        escalateAfterOccurrences: 3,
      },
    );
    this.locks = new PersistentLockService(database);
    this.coordinator = new ExecutionCoordinator(this.locks, this.instanceId);
    this.persistentCircuits = new PersistentCircuitBreakerService(
      new PrismaCircuitBreakerRepository(database),
    );
    const rateBudget = new PersistentRateBudget(database, `alpaca:${config.trading.mode}`, 180, 3);
    const baseRecorder = createBrokerRequestRecorder(database);
    const recorder = async (observation: BrokerRequestObservation): Promise<void> => {
      await baseRecorder(observation);
      if (observation.outcome === 'SUCCEEDED')
        await this.persistentCircuits.recordSuccess('BROKER', observation.path);
      else
        await this.persistentCircuits.recordFailure({
          scope: 'BROKER',
          scopeId: observation.path,
          reason: observation.outcome,
          threshold: observation.statusCode === 401 || observation.statusCode === 403 ? 1 : 5,
          cooldownMs: 30_000,
        });
      if (observation.outcome !== 'SUCCEEDED')
        await this.raiseAlert({
          kind: 'ALPACA_DISCONNECTED',
          severity:
            observation.statusCode === 401 || observation.statusCode === 403
              ? 'EMERGENCY'
              : 'WARNING',
          title: 'Broker request failed',
          message: `${observation.method} ${observation.path}: ${observation.outcome}`,
          component: 'alpaca-http',
          scope: observation.path,
          metadata: {
            statusCode: observation.statusCode ?? null,
            latencyMs: observation.latencyMs,
          },
        });
    };
    const readHttp = new AlpacaHttpClient(
      config,
      rateBudget,
      new CircuitBreaker(),
      logger,
      undefined,
      undefined,
      undefined,
      'READ_ONLY',
      recorder,
    );
    const writeHttp = new AlpacaHttpClient(
      config,
      rateBudget,
      new CircuitBreaker(),
      logger,
      undefined,
      undefined,
      undefined,
      'TRADING',
      recorder,
    );
    this.readTrading = new AlpacaTradingClient(readHttp);
    this.writeTrading = new AlpacaTradingClient(writeHttp);
    this.marketData = new AlpacaMarketDataClient(
      readHttp,
      new MarketDataCache(),
      config.alpaca.dataFeed,
    );
    this.corporateActions = new AlpacaCorporateActionsClient(readHttp);
    this.calendar = new MarketCalendarService(this.readTrading);
    this.marketStream = new AlpacaMarketStream(
      config,
      this.haltService,
      this.marketHealth,
      logger,
      config.alpaca.dataFeed,
      {
        onBar: (bar) => this.recordStreamFreshness(bar.symbol, 'bar', bar.timestamp),
        onQuote: (quote) => this.recordStreamFreshness(quote.symbol, 'quote', quote.timestamp),
        onTrade: (trade) => this.recordStreamFreshness(trade.symbol, 'trade', trade.timestamp),
        onDisconnected: (symbols, at) => this.handleMarketStreamDisconnect(symbols, at),
        onRecovered: (symbols, disconnectedAt, reconnectedAt) =>
          this.recoverMarketStream(symbols, disconnectedAt, reconnectedAt),
      },
    );
    this.strategyEngine = new StrategyEngine({
      configurationSnapshot: {
        deploymentId: config.trading.deploymentId,
        releaseSha: config.trading.releaseSha,
      },
      persistence: {
        saveSignal: (signal) => this.saveSignal(signal),
        saveMigration: async (migration) => {
          await database.strategyVersionMigrationRecord.create({ data: migration });
        },
        hasSignal: async (key) =>
          (await database.strategySignalRecord.count({ where: { deduplicationKey: key } })) > 0,
        lastEntrySignalAt: async (scope) =>
          (
            await database.strategySignalRecord.findFirst({
              where: {
                strategyId: scope.strategyId,
                strategyVersion: scope.strategyVersion,
                symbol: scope.symbol,
                type: 'BUY',
              },
              orderBy: { signaledAt: 'desc' },
            })
          )?.signaledAt,
        countActionableSignals: (scope) =>
          database.strategySignalRecord.count({
            where: {
              strategyId: scope.strategyId,
              strategyVersion: scope.strategyVersion,
              signaledAt: { gte: scope.from, lt: scope.to },
              type: { in: ['BUY', 'SELL', 'EXIT'] },
            },
          }),
      },
    });
    const metadata = {
      version: '1.0.0',
      configurationVersion: 'runtime-v1',
      deploymentId: config.trading.deploymentId,
    } as const;
    for (const strategy of [
      createTrendStrategy(metadata),
      createMeanReversionStrategy(metadata),
      createBreakoutStrategy(metadata),
    ])
      this.strategyEngine.register(strategy);

    this.riskGate = new PreTradeRiskGate({
      save: async (decision) => {
        await database.riskDecisionRecord.create({
          data: {
            id: decision.id,
            signalId: decision.signalId,
            symbol: decision.symbol,
            outcome: decision.outcome,
            reasonCodes: [...decision.reasonCodes],
            riskConfigurationId: decision.configurationSnapshotId,
            decisionSnapshot: { ...decision.decisionSnapshot },
            evaluatedAt: decision.evaluatedAt,
          },
        });
      },
    });

    this.reconciliation = new ReconciliationService({
      applySafeOrderStateCorrection: (id, state) =>
        this.transitionOrder(id, state, 'Broker-authoritative reconciliation'),
      persist: async (result) => {
        await database.reconciliationRecord.create({
          data: {
            id: result.id,
            trigger: result.trigger,
            state: result.blocked
              ? 'BLOCKED'
              : result.safeCorrectionsApplied > 0
                ? 'CORRECTED'
                : 'MATCHED',
            safeCorrectionsApplied: result.safeCorrectionsApplied,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            discrepancies: {
              create: result.discrepancies.map((item) => ({
                code: item.code,
                classification: item.classification,
                entityId: item.entityId,
                ...(item.localValue ? { localValue: item.localValue } : {}),
                ...(item.brokerValue ? { brokerValue: item.brokerValue } : {}),
                detail: item.detail,
              })),
            },
          },
        });
      },
      blockSafety: async (result) => {
        await this.safety.block({
          scope: 'GLOBAL',
          reason: 'RECONCILIATION_FAILED',
          detail: `Reconciliation ${result.id} found blocking discrepancies`,
          at: result.finishedAt,
          cooldownMs: 60_000,
        });
      },
    });

    const tradeRepository = new PrismaTradeExecutionRepository(database, this.coordinator);
    this.executor = new TradeExecutor({
      repository: tradeRepository,
      safety: this.safety,
      tradingMode: config.trading.mode,
      submitOrder: (request) => this.writeTrading.submitOrder(request),
      finalValidate: (intent) => this.finalValidate(intent),
      recalculateSizing: (intent) => this.recalculateSizing(intent),
      finalRiskGate: (intent, sizing) => this.finalRisk(intent, sizing),
      getReferencePrice: (symbol) => this.referencePrice(symbol),
      requestReconciliation: async (_clientOrderId, _reason) => {
        await this.reconcile('SUBMIT_TIMEOUT', randomUUID());
      },
    });

    this.scanner = new ScannerService(this.strategyEngine, {
      findExecutionByIdempotencyKey: (key) => this.findScan(key),
      executeWithLock: (executionId, operation) =>
        this.coordinator.exclusively(['scanner:global'], 180_000, operation),
      loadWatchlist: async () =>
        (
          await database.watchlistRecord.findMany({
            where: { active: true },
            include: { asset: true },
          })
        )
          .filter((item) => item.asset.tradable && item.asset.status === 'active')
          .map((item) => item.asset.symbol),
      loadMarketData: (symbol) => this.loadValidatedMarketData(symbol),
      validateMarketData: (symbol, data) => this.marketRejections(symbol, data),
      buildContext: (symbol, data, now) => this.buildContextSync(symbol, data, now),
      selectStrategies: (context) => {
        const selected = selectStrategyForRegime(this.strategyEngine.getActive(), context);
        return selected ? [selected] : [];
      },
      preRankingFilter: (signal) =>
        signal.expiresAt <= new Date() ? 'Signal expired before ranking' : undefined,
      postRankingFilter: (candidate) =>
        candidate.rank > 5 ? 'Per-run candidate capacity reached' : undefined,
      score: (signal) =>
        (signal.confidence ?? 0) * 100 + Math.min(100, signal.expectedEdgeBps ?? 0),
      routeCandidate: (candidate, executionId) => this.routeCandidate(candidate, executionId),
      saveExecution: (execution) => this.saveScan(execution),
    });

    this.scheduler = new SchedulerService(
      schedulerSnapshot.configuration,
      {
        acquireLock: async (executionId, ttlMs) =>
          (await this.locks.acquire('scheduler:leader', executionId, ttlMs)) !== null,
        releaseLock: async (executionId) => {
          const current = await database.distributedLock.findUnique({
            where: { name: 'scheduler:leader' },
          });
          if (current?.ownerId === executionId)
            await database.distributedLock.delete({ where: { name: 'scheduler:leader' } });
        },
        safetyAllowsOperation: () =>
          !['KILL_SWITCH', 'EMERGENCY_STOP'].includes(this.safety.snapshot().mode) &&
          config.trading.brokerConnectivityEnabled,
        runPipeline: async (_executionId, idempotencyKey) => {
          await this.scanner.execute({
            idempotencyKey: `scanner:${idempotencyKey}`,
            trigger: 'SCHEDULED',
            now: new Date(),
            maximumSymbols: config.runtime.scannerMaxSymbols,
            maximumDurationMs: config.runtime.scannerTimeoutMs,
          });
        },
        saveState: (snapshot) => this.saveSchedulerState(snapshot),
        saveExecution: (execution) => this.saveSchedulerExecution(execution),
      },
      schedulerSnapshot,
    );
    this.schedulerWorker = new SchedulerWorker({
      scheduler: this.scheduler,
      workerId: this.instanceId,
      heartbeatIntervalMs: config.runtime.workerHeartbeatIntervalMs,
      saveHeartbeat: (heartbeat) => this.saveWorkerHeartbeat(heartbeat),
      logger,
    });
  }

  public static async create(input: {
    config: AppConfig;
    database: DatabaseClient;
    logger: Logger;
    operationalState: OperationalStateService;
  }): Promise<TradingRuntime> {
    const recoveredSafety = await loadSafetyState(input.database, input.config.trading.mode);
    const safety = new OperationalSafetyService(
      input.config.trading.mode,
      new PrismaSafetyRepository(input.database),
      randomUUID,
      recoveredSafety,
    );
    const configuration =
      (await input.database.schedulerConfigurationRecord.findFirst({
        where: { active: true },
        orderBy: { updatedAt: 'desc' },
      })) ??
      (await input.database.schedulerConfigurationRecord.create({
        data: {
          id: 'runtime-default',
          intervalMs: input.config.runtime.schedulerIntervalMs,
          maximumDriftMs: 5_000,
          lockTtlMs: Math.max(120_000, input.config.runtime.schedulerIntervalMs * 2),
          enabled: false,
          active: true,
        },
      }));
    const state = await input.database.schedulerStateRecord.findUnique({
      where: { id: 'singleton' },
    });
    const snapshot: SchedulerSnapshot = {
      state: state?.state ?? 'STOPPED',
      configuration: {
        id: configuration.id,
        intervalMs: configuration.intervalMs,
        maximumDriftMs: configuration.maximumDriftMs,
        lockTtlMs: configuration.lockTtlMs,
        enabled: configuration.enabled,
      },
      ...(state?.nextExecutionAt ? { nextExecutionAt: state.nextExecutionAt } : {}),
      ...(state?.lastExecutionAt ? { lastExecutionAt: state.lastExecutionAt } : {}),
      ...(state?.activeExecutionId ? { activeExecutionId: state.activeExecutionId } : {}),
    };
    return new TradingRuntime(
      input.config,
      input.database,
      input.logger,
      input.operationalState,
      safety,
      snapshot,
    );
  }

  public async start(): Promise<void> {
    await this.safety.disableEntries(
      'runtime',
      'Startup recovery and reconciliation in progress',
      new Date(),
    );
    this.alertRetryTimer = setInterval(
      () =>
        void this.alerts
          .retryDue(new Date())
          .catch((error: unknown) =>
            this.logger.error({ err: error }, 'Alert redelivery cycle failed'),
          ),
      30_000,
    );
    this.alertRetryTimer.unref();
    if (!this.config.trading.brokerConnectivityEnabled) {
      await this.operationalState.transition('BLOCKED', 'BROKER_CONNECTIVITY_DISABLED', 'runtime');
      return;
    }
    try {
      await this.syncAssetCatalog();
      await this.syncStrategyVersions();
      await this.syncCorporateActions();
      await this.refreshCalendarAndClock();
      const account = await this.readTrading.getAccount();
      if (!accountTradeable(account)) throw new Error('ALPACA_ACCOUNT_NOT_TRADEABLE');
      const recoveryId = await this.recoverInterruptedWork();
      const startupReconciliation = (await this.reconcile(
        'STARTUP',
        randomUUID(),
      )) as ReconciliationResult;
      await this.completeRecovery(recoveryId, startupReconciliation);
      const symbols = await this.activeSymbols();
      if (symbols.length > 0) {
        await Promise.all(symbols.map((symbol) => this.loadValidatedMarketData(symbol)));
        await this.marketStream
          .start(symbols)
          .catch((error: unknown) =>
            this.logger.error({ err: error }, 'Market status stream did not start'),
          );
      }
      await this.schedulerWorker.start();
      this.reconciliationTimer = setInterval(
        () =>
          void this.syncCorporateActions()
            .then(() => this.reconcile('SCHEDULED', randomUUID()))
            .catch((error: unknown) =>
              this.logger.error({ err: error }, 'Periodic synchronization failed'),
            ),
        this.config.runtime.reconciliationIntervalMs,
      );
      this.reconciliationTimer.unref();
      this.readinessTimer = setInterval(
        () =>
          void this.reassessOperationalReadiness().catch((error: unknown) =>
            this.logger.error({ err: error }, 'Continuous readiness reassessment failed'),
          ),
        Math.min(30_000, this.config.runtime.reconciliationIntervalMs),
      );
      this.readinessTimer.unref();
      const readiness = await this.entryReadinessChecks();
      if (
        this.config.trading.mode === 'PAPER' &&
        Object.values(readiness).every(Boolean) &&
        this.safety.snapshot().blocks.length === 0
      )
        await this.safety.activate({
          actor: 'runtime',
          reason: 'Startup gates passed',
          at: new Date(),
        });
      if (this.config.trading.mode === 'LIVE')
        await this.database.liveReadinessRecord.updateMany({
          where: { state: 'ACTIVE' },
          data: { state: 'REVOKED', revokedAt: new Date() },
        });
      await this.operationalState.transition(
        this.safety.snapshot().entriesEnabled ? 'READY' : 'BLOCKED',
        this.safety.snapshot().entriesEnabled ? 'RUNTIME_READY' : 'ENTRY_GATES_NOT_SATISFIED',
        'runtime',
      );
    } catch (error) {
      await this.safety.block({
        scope: 'GLOBAL',
        reason: 'BROKER_DISCONNECTED',
        detail: error instanceof Error ? error.message : 'Runtime startup failed',
        at: new Date(),
        cooldownMs: 60_000,
      });
      await this.operationalState.transition('BLOCKED', 'RUNTIME_STARTUP_FAILED', 'runtime');
      await this.raiseAlert({
        kind: 'SYSTEM_BLOCKED',
        severity: 'CRITICAL',
        title: 'Trading runtime startup blocked',
        message: error instanceof Error ? error.message : 'Runtime startup failed',
        component: 'runtime',
        scope: 'startup',
      });
      throw error;
    }
  }

  public async shutdown(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    this.stopping = true;
    await this.safety.disableEntries('runtime', 'Graceful shutdown', new Date());
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    if (this.readinessTimer) clearInterval(this.readinessTimer);
    if (this.alertRetryTimer) clearInterval(this.alertRetryTimer);
    const workerDrained = await this.schedulerWorker.stop(Math.max(0, deadline - Date.now()));
    const manualDrained = await this.waitForCriticalOperations(Math.max(0, deadline - Date.now()));
    this.marketStream.stop();
    if (!workerDrained || !manualDrained) {
      const at = new Date();
      const ambiguousOrders = await this.database.orderRecord.findMany({
        where: { state: 'SUBMITTING' },
        select: { id: true },
      });
      for (const order of ambiguousOrders)
        await this.transitionOrder(
          order.id,
          'UNKNOWN',
          'Shutdown timeout requires startup reconciliation',
        );
      await this.database.tradeIntentRecord.updateMany({
        where: { state: 'EXECUTING' },
        data: {
          state: 'UNKNOWN',
          rejectionReasons: ['SHUTDOWN_TIMEOUT_REQUIRES_STARTUP_RECONCILIATION'],
        },
      });
      await this.safety.block({
        scope: 'GLOBAL',
        reason: 'UNKNOWN_ORDER',
        detail: 'Critical operation exceeded shutdown timeout; startup reconciliation is mandatory',
        at,
        cooldownMs: 0,
      });
      this.logger.error(
        { workerDrained, manualDrained },
        'Shutdown persisted ambiguous work for startup reconciliation',
      );
    }
  }

  public scannerRun(context: RuntimeActionContext): Promise<ScannerExecution> {
    return this.trackCritical(async () => {
      this.assertBrokerEnabled();
      return this.scanner.execute({
        idempotencyKey: `manual:${context.correlationId}`,
        trigger: 'MANUAL',
        now: new Date(),
        maximumSymbols: this.config.runtime.scannerMaxSymbols,
        maximumDurationMs: this.config.runtime.scannerTimeoutMs,
      });
    });
  }

  public closePosition(positionId: string, context: RuntimeActionContext): Promise<unknown> {
    return this.trackCritical(() => this.closePositionInternal(positionId, context));
  }

  private async closePositionInternal(
    positionId: string,
    context: RuntimeActionContext,
  ): Promise<unknown> {
    this.assertBrokerEnabled();
    const position = await this.database.managedPositionRecord.findFirst({
      where: { id: positionId, closedAt: null },
    });
    if (!position) throw new InputValidationError('POSITION_NOT_OPEN', 'Position is not open');
    const now = new Date();
    const signal: StrategySignal = {
      id: randomUUID(),
      timestamp: now,
      symbol: position.symbol,
      strategyId: position.strategyId,
      strategyVersion: position.strategyVersion,
      configurationVersion: 'position-bound',
      deploymentId: this.config.trading.deploymentId,
      type: 'EXIT',
      reason: `Operator close requested by ${context.actor}`,
      expiresAt: new Date(now.getTime() + 60_000),
      parametersSnapshot: {},
      configurationSnapshot: { positionId },
      deduplicationKey: sha256(`close:${positionId}:${position.remainingQuantity.toFixed()}`),
    };
    await this.saveSignal(signal);
    await this.journal(context.correlationId, 'SIGNAL', {
      signalId: signal.id,
      type: signal.type,
      symbol: signal.symbol,
      strategyId: signal.strategyId,
      strategyVersion: signal.strategyVersion,
    });
    const intent = await this.createIntent(signal, context.correlationId, 'sell', 'simple');
    await this.journal(
      context.correlationId,
      'TRADE_INTENT',
      { intentId: intent.id, side: 'sell', positionId },
      intent.id,
    );
    await this.database.managedPositionRecord.update({
      where: { id: position.id },
      data: { pendingExitIntentId: intent.id },
    });
    const result = await this.executor.execute(intent);
    await this.journal(context.correlationId, 'ORDER', { intentId: intent.id, result }, intent.id);
    await this.reconcile('MANUAL', context.correlationId);
    return result;
  }

  public cancelOrder(orderId: string, context: RuntimeActionContext): Promise<unknown> {
    return this.trackCritical(() => this.cancelOrderInternal(orderId, context));
  }

  private async cancelOrderInternal(
    orderId: string,
    context: RuntimeActionContext,
  ): Promise<unknown> {
    this.assertBrokerEnabled();
    return this.coordinator.exclusively([`order:${orderId}`], 60_000, async () => {
      const order = await this.database.orderRecord.findUnique({ where: { id: orderId } });
      if (!order?.brokerOrderId)
        throw new InputValidationError('BROKER_ORDER_ID_MISSING', 'Order has no broker identity');
      if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED'].includes(order.state))
        throw new InputValidationError('ORDER_TERMINAL', 'Terminal order cannot be canceled');
      await this.transitionOrder(
        order.id,
        'CANCEL_PENDING',
        `Cancel requested by ${context.actor}`,
      );
      try {
        await this.writeTrading.cancelOrder(order.brokerOrderId);
      } catch (error) {
        if (error instanceof AlpacaUnknownOutcomeError) {
          await this.transitionOrder(order.id, 'UNKNOWN', 'Cancel outcome unknown');
          await this.raiseAlert({
            kind: 'ORDER_UNKNOWN',
            severity: 'CRITICAL',
            title: 'Order cancellation outcome unknown',
            message: `Order ${order.id} requires broker-authoritative reconciliation`,
            component: 'execution',
            scope: order.id,
            correlationId: context.correlationId,
          });
          await this.reconcile('CRITICAL_ERROR', context.correlationId);
          return { orderId, state: 'UNKNOWN', reconciliationRequired: true };
        }
        throw error;
      }
      await this.reconcile('MANUAL', context.correlationId);
      return this.database.orderRecord.findUnique({ where: { id: order.id } });
    });
  }

  public async editRisk(configuration: unknown, context: RuntimeActionContext): Promise<unknown> {
    const parsed = riskConfigurationSchema.safeParse(configuration);
    if (!parsed.success)
      throw new InputValidationError('RISK_CONFIGURATION_INVALID', 'Risk configuration is invalid');
    const snapshot = createRiskConfigurationSnapshot(parsed.data, new Date());
    const active = await this.database.riskConfigurationRecord.findFirst({
      where: { active: true },
    });
    await this.database.$transaction(
      async (transaction) => {
        if (active)
          await transaction.riskConfigurationRecord.update({
            where: { id: active.id },
            data: { active: false },
          });
        await transaction.riskConfigurationRecord.create({
          data: {
            id: snapshot.id,
            version: snapshot.configuration.version,
            checksum: snapshot.checksum,
            configuration: snapshot.configuration,
            active: true,
            activatedAt: snapshot.createdAt,
            activatedBy: context.actor,
            ...(active ? { supersedesId: active.id } : {}),
          },
        });
        await transaction.auditEvent.create({
          data: {
            operatorId: context.actor,
            severity: 'WARNING',
            action: 'RISK_CONFIGURATION_ACTIVATED',
            resourceType: 'RISK_CONFIGURATION',
            resourceId: snapshot.id,
            correlationId: context.correlationId,
            outcome: 'SUCCEEDED',
            metadata: { checksum: snapshot.checksum, supersedesId: active?.id ?? null },
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
    const positions = await this.database.managedPositionRecord.count({
      where: { closedAt: null },
    });
    if (positions > snapshot.configuration.maximumPositions)
      await this.safety.block({
        scope: 'GLOBAL',
        reason: 'INVALID_CONFIGURATION',
        detail: 'New risk version leaves existing positions outside limits; entries remain blocked',
        at: new Date(),
        cooldownMs: 0,
        actor: context.actor,
      });
    return snapshot;
  }

  public async recoverSafety(
    input: { blockId?: string; checks?: Readonly<Record<string, boolean>> },
    context: RuntimeActionContext,
  ): Promise<unknown> {
    const checks = {
      ...(await this.entryReadinessChecks()),
      riskLimits: await this.riskLimitsHealthy(),
      ...Object.fromEntries(
        Object.entries(input.checks ?? {}).map(([name, passed]) => [`operator:${name}`, passed]),
      ),
    };
    const blockIds = input.blockId
      ? [input.blockId]
      : this.safety.snapshot().blocks.map((block) => block.id);
    for (const blockId of blockIds)
      await this.safety.recover({
        blockId,
        actor: context.actor,
        reason: 'Runtime dependencies revalidated',
        at: new Date(),
        checks,
      });
    if (
      this.config.trading.mode === 'PAPER' &&
      Object.values(checks).every(Boolean) &&
      this.safety.snapshot().blocks.length === 0
    ) {
      await this.safety.activate({
        actor: context.actor,
        reason: 'Controlled recovery passed',
        at: new Date(),
      });
      await this.operationalState.transition('READY', 'CONTROLLED_RECOVERY_PASSED', context.actor);
    }
    if (this.config.trading.mode === 'LIVE')
      await this.operationalState.transition(
        'BLOCKED',
        'LIVE_REACTIVATION_CHALLENGE_REQUIRED',
        context.actor,
      );
    return { checks, safety: this.safety.snapshot() };
  }

  public async acknowledgeAlert(alertId: string, context: RuntimeActionContext): Promise<unknown> {
    const alert = await this.database.alertRecord.findUnique({ where: { id: alertId } });
    if (!alert) throw new InputValidationError('ALERT_NOT_FOUND', 'Alert not found');
    if (!['CRITICAL', 'EMERGENCY'].includes(alert.severity))
      throw new InputValidationError(
        'ALERT_ACK_NOT_REQUIRED',
        'Only critical or emergency alerts require acknowledgement',
      );
    const now = new Date();
    return this.database.$transaction(async (transaction) => {
      const acknowledged = await transaction.alertRecord.update({
        where: { id: alertId },
        data: {
          state: 'ACKNOWLEDGED',
          acknowledgedAt: now,
          acknowledgedBy: context.actor,
        },
      });
      await transaction.auditEvent.create({
        data: {
          operatorId: context.actor,
          severity: 'WARNING',
          action: 'ALERT_ACKNOWLEDGED',
          resourceType: 'ALERT',
          resourceId: alertId,
          correlationId: context.correlationId,
          outcome: 'SUCCEEDED',
          metadata: { kind: alert.kind, severity: alert.severity },
        },
      });
      return acknowledged;
    });
  }

  public async killSwitch(context: RuntimeActionContext): Promise<void> {
    await this.safety.killSwitch(context.actor, 'Manual kill switch', new Date());
    await this.operationalState.transition('EMERGENCY', 'KILL_SWITCH_MANUAL', context.actor);
    await this.raiseAlert({
      kind: 'KILL_SWITCH_ACTIVE',
      severity: 'EMERGENCY',
      title: 'Kill switch activated',
      message: `Manual kill switch activated by ${context.actor}`,
      component: 'safety',
      scope: 'global',
      correlationId: context.correlationId,
    });
    if (this.config.trading.brokerConnectivityEnabled) {
      const orders = await this.database.orderRecord.findMany({
        where: {
          side: 'buy',
          state: { in: ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_PENDING'] },
          brokerOrderId: { not: null },
        },
      });
      for (const order of orders)
        if (order.brokerOrderId)
          await this.writeTrading
            .cancelOrder(order.brokerOrderId)
            .catch((error: unknown) =>
              this.logger.error({ err: error, orderId: order.id }, 'Kill switch cancel failed'),
            );
      await this.reconcile('CRITICAL_ERROR', context.correlationId);
    }
  }

  public disableEntries(context: RuntimeActionContext): Promise<void> {
    return this.safety.disableEntries(context.actor, 'Operator disabled entries', new Date());
  }

  public async schedulerStart(_context: RuntimeActionContext): Promise<void> {
    this.assertBrokerEnabled();
    await this.scheduler.start();
    this.schedulerWorker.wake();
  }

  public async schedulerPause(_context: RuntimeActionContext): Promise<void> {
    await this.scheduler.pause();
    this.schedulerWorker.wake();
  }

  public async schedulerResume(_context: RuntimeActionContext): Promise<void> {
    this.assertBrokerEnabled();
    await this.scheduler.resume();
    this.schedulerWorker.wake();
  }

  public async schedulerStop(_context: RuntimeActionContext): Promise<void> {
    await this.scheduler.stop();
    this.schedulerWorker.wake();
  }

  public async activateLive(context: RuntimeActionContext): Promise<void> {
    if (
      this.config.app.environment !== 'production' ||
      this.config.trading.mode !== 'LIVE' ||
      !this.config.trading.liveTradingEnabled
    )
      throw new AppError(
        'LIVE_RUNTIME_CONFIGURATION_INVALID',
        'Runtime is not configured for LIVE activation',
        409,
        'CONFIGURATION',
        'CRITICAL',
      );
    const assessment = await this.database.liveReadinessRecord.findFirst({
      orderBy: { assessedAt: 'desc' },
    });
    if (
      assessment?.state !== 'ACTIVE' ||
      assessment.expiresAt <= new Date() ||
      assessment.revokedAt !== null
    )
      throw new AppError(
        'LIVE_ASSESSMENT_NOT_ACTIVE',
        'A fresh active LIVE assessment is required',
        409,
        'SAFETY',
        'CRITICAL',
      );
    const checks = await this.entryReadinessChecks();
    if (!Object.values(checks).every(Boolean) || this.safety.snapshot().blocks.length > 0)
      throw new AppError(
        'LIVE_RUNTIME_GATES_FAILED',
        'Runtime gates changed before activation',
        409,
        'SAFETY',
        'CRITICAL',
      );
    if (!this.safety.snapshot().entriesEnabled)
      await this.safety.activate({
        actor: context.actor,
        reason: `LIVE assessment ${assessment.id} activated`,
        at: new Date(),
      });
    await this.operationalState.transition('READY', 'LIVE_ACTIVATED_EXPLICITLY', context.actor);
  }

  public async startBacktest(
    input: {
      readonly symbol: string;
      readonly strategyId: string;
      readonly from?: string;
      readonly to?: string;
      readonly initialCapital?: number;
    },
    context: RuntimeActionContext,
  ): Promise<unknown> {
    this.assertBrokerEnabled();
    const symbol = input.symbol.toUpperCase();
    const asset = await this.database.assetRecord.findUnique({ where: { symbol } });
    if (!asset?.tradable)
      throw new InputValidationError('BACKTEST_ASSET_INVALID', 'Backtest asset is not tradable');
    const strategy = this.strategyEngine
      .getActive()
      .find((candidate) => candidate.id === input.strategyId);
    if (!strategy)
      throw new InputValidationError('BACKTEST_STRATEGY_INVALID', 'Strategy is not active');
    const id = randomUUID();
    const to = input.to
      ? new Date(`${input.to}T20:00:00.000Z`)
      : new Date(Date.now() - timeframeMilliseconds(strategy.timeframe));
    const from = input.from
      ? new Date(`${input.from}T00:00:00.000Z`)
      : new Date(to.getTime() - 90 * 86_400_000);
    const initialCapital = input.initialCapital ?? 100_000;
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      from >= to ||
      to.getTime() - from.getTime() > 2 * 366 * 86_400_000
    )
      throw new InputValidationError(
        'BACKTEST_RANGE_INVALID',
        'Backtest range must be valid and no longer than two years',
      );
    if (!Number.isFinite(initialCapital) || initialCapital < 1_000 || initialCapital > 10_000_000)
      throw new InputValidationError(
        'BACKTEST_CAPITAL_INVALID',
        'Initial capital must be between USD 1,000 and USD 10,000,000',
      );
    const job = await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('backtest:queue'))`;
      const activeJobs = await transaction.backtestJobRecord.count({
        where: { status: { in: ['QUEUED', 'RUNNING', 'CANCELING'] } },
      });
      if (activeJobs >= 2)
        throw new AppError(
          'BACKTEST_CAPACITY_REACHED',
          'At most two backtest jobs may be queued or running',
          429,
          'DEPENDENCY',
          'WARNING',
        );
      return transaction.backtestJobRecord.create({
        data: {
          id,
          status: 'QUEUED',
          progress: 0,
          request: toJsonValue({
            symbol,
            strategyId: strategy.id,
            strategyVersion: strategy.version,
            from,
            to,
            initialCapital,
            requestedBy: context.actor,
            correlationId: context.correlationId,
          }),
        },
      });
    });
    setImmediate(
      () =>
        void this.runBacktestJob(id, symbol, strategy, from, to, initialCapital).catch(
          (error: unknown) =>
            this.logger.error({ err: error, jobId: id }, 'Backtest worker failed'),
        ),
    );
    return job;
  }

  public async cancelBacktest(jobId: string, _context: RuntimeActionContext): Promise<unknown> {
    const updated = await this.database.backtestJobRecord.updateMany({
      where: { id: jobId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { cancelAt: new Date(), status: 'CANCELING' },
    });
    if (updated.count !== 1)
      throw new InputValidationError(
        'BACKTEST_JOB_NOT_CANCELABLE',
        'Backtest job does not exist or is terminal',
      );
    return this.getBacktestJob(jobId);
  }

  public getBacktestJob(jobId: string): Promise<unknown> {
    return this.database.backtestJobRecord.findUniqueOrThrow({ where: { id: jobId } });
  }

  public async updateWatchlist(
    symbol: string,
    active: boolean,
    context: RuntimeActionContext,
  ): Promise<unknown> {
    this.assertBrokerEnabled();
    const asset = await this.database.assetRecord.findUnique({ where: { symbol } });
    if (!asset)
      throw new InputValidationError('ASSET_NOT_FOUND', 'Asset not found in broker catalog');
    if (!asset.tradable || asset.status !== 'active')
      throw new InputValidationError('ASSET_NOT_TRADABLE', 'Asset is not currently tradable');
    const record = await this.database.$transaction(async (transaction) => {
      const updated = await transaction.watchlistRecord.upsert({
        where: { assetId: asset.id },
        create: { assetId: asset.id, active },
        update: { active },
      });
      await transaction.auditEvent.create({
        data: {
          operatorId: context.actor,
          severity: 'INFO',
          action: active ? 'WATCHLIST_ENABLED' : 'WATCHLIST_DISABLED',
          resourceType: 'watchlist',
          resourceId: symbol,
          correlationId: context.correlationId,
          outcome: 'SUCCEEDED',
          metadata: { symbol, active },
        },
      });
      return updated;
    });
    if (active) await this.loadValidatedMarketData(symbol);
    await this.marketStream.replaceSymbols(await this.activeSymbols());
    return record;
  }

  public async reconcile(trigger: ReconciliationTrigger, correlationId: string): Promise<unknown> {
    this.assertBrokerEnabled();
    const outcome = await this.coordinator.exclusively(
      ['reconciliation:global'],
      120_000,
      async () => {
        const [account, brokerOrders, brokerPositions, brokerFills] = await Promise.all([
          this.readTrading.getAccount(),
          this.readTrading.listOrders('all'),
          this.readTrading.listPositions(),
          this.readTrading.listActivities(['FILL']),
        ]);
        await this.synchronizeFills(brokerFills, brokerOrders, correlationId);
        await this.applyVerifiedCorporateActions(brokerPositions);
        const unprotectedPositionIds = await this.synchronizeProtectionGroups(brokerOrders);
        await this.persistPortfolio(account, brokerPositions, brokerOrders);
        const [orders, positions, fills, portfolio] = await Promise.all([
          this.database.orderRecord.findMany({ include: { intent: true } }),
          this.database.managedPositionRecord.findMany({ where: { closedAt: null } }),
          this.database.fillRecord.findMany(),
          this.database.portfolioSnapshot.findFirst({ orderBy: { createdAt: 'desc' } }),
        ]);
        const result = await this.reconciliation.reconcile({
          trigger,
          localOrders: orders.map((order) => ({
            id: order.id,
            ...(order.brokerOrderId ? { brokerOrderId: order.brokerOrderId } : {}),
            clientOrderId: order.clientOrderId,
            symbol: order.symbol,
            state: order.state,
            requestedQuantity: order.requestedQuantity.toFixed(),
            filledQuantity: order.filledQuantity.toFixed(),
          })),
          localPositions: positions.map((position) => ({
            symbol: position.symbol,
            quantity: position.remainingQuantity.toFixed(),
            averageEntryPrice: position.averageEntryPrice.toFixed(),
          })),
          localFills: fills.map((fill) => ({
            id: fill.id,
            symbol: fill.symbol,
            quantity: fill.quantity.toFixed(),
            price: fill.price.toFixed(),
          })),
          localAccount: {
            cash: portfolio?.cash.toFixed() ?? '0',
            equity: portfolio?.equity.toFixed() ?? '0',
            buyingPower: portfolio?.buyingPower.toFixed() ?? '0',
          },
          brokerOrders,
          brokerPositions,
          brokerFills,
          brokerAccount: account,
          moneyTolerance: '0.01',
          quantityTolerance: '0.000001',
        });
        await this.database.reconciliationRecord.update({
          where: { id: result.id },
          data: {
            brokerSnapshot: toJsonValue({
              account,
              orders: brokerOrders,
              positions: brokerPositions,
              fillIds: brokerFills.map((fill) => fill.id),
            }),
            localSnapshot: toJsonValue({
              orderIds: orders.map((order) => order.id),
              positions: positions.map((position) => ({
                symbol: position.symbol,
                quantity: position.remainingQuantity.toFixed(),
              })),
              fillIds: fills.map((fill) => fill.id),
            }),
          },
        });
        if (result.blocked)
          await this.raiseAlert({
            kind: 'RECONCILIATION_MISMATCH',
            severity: 'CRITICAL',
            title: 'Broker reconciliation blocked trading',
            message: `Reconciliation ${result.id} found ${result.discrepancies.length} discrepancies`,
            component: 'reconciliation',
            scope: result.id,
            correlationId,
            metadata: {
              trigger,
              discrepancyCodes: result.discrepancies.map((item) => item.code),
            },
          });
        for (const order of orders)
          await this.journal(
            order.intent.correlationId,
            'RECONCILIATION',
            {
              reconciliationId: result.id,
              trigger,
              blocked: result.blocked,
              discrepancyCodes: result.discrepancies.map((item) => item.code),
            },
            order.tradeIntentId,
          );
        return { result, unprotectedPositionIds };
      },
    );
    for (const positionId of outcome.unprotectedPositionIds)
      await this.closePosition(positionId, {
        actor: 'protection-monitor',
        correlationId,
      }).catch((error: unknown) =>
        this.logger.error(
          { err: error, positionId, correlationId },
          'Fail-safe close for unprotected position failed',
        ),
      );
    return outcome.result;
  }

  private async recoverInterruptedWork(): Promise<string> {
    const now = new Date();
    const [orders, expiredSignals, incompleteScans, staleLocks, riskCount, schedulerState] =
      await Promise.all([
        this.database.orderRecord.findMany({
          where: { state: { in: ['SUBMITTING', 'UNKNOWN'] } },
          select: { id: true, clientOrderId: true, state: true },
        }),
        this.database.strategySignalRecord.findMany({
          where: { state: 'ACTIVE', expiresAt: { lte: now } },
          select: { id: true, expiresAt: true },
        }),
        this.database.scannerExecutionRecord.findMany({
          where: { status: 'RUNNING' },
          select: { id: true },
        }),
        this.database.distributedLock.findMany({
          where: { expiresAt: { lte: now } },
          select: { name: true },
        }),
        this.database.riskConfigurationRecord.count({ where: { active: true } }),
        this.database.schedulerStateRecord.findUnique({ where: { id: 'singleton' } }),
      ]);
    const plan = this.recovery.plan(
      {
        orders: orders.map((order) => ({
          id: order.id,
          clientOrderId: order.clientOrderId,
          state: order.state,
        })),
        signals: expiredSignals.map((signal) => ({
          id: signal.id,
          expiresAt: signal.expiresAt,
          active: true,
        })),
        incompleteExecutions: incompleteScans.map((scan) => scan.id),
        openBrokerOrderIds: [],
        partiallyFilledOrderIds: orders
          .filter((order) => order.state === 'PARTIALLY_FILLED')
          .map((order) => order.id),
        safetyStateRecovered: true,
        schedulerStateRecovered: schedulerState !== null,
        activeRiskConfigurationRecovered: riskCount === 1,
        staleLockNames: staleLocks.map((lock) => lock.name),
      },
      now,
    );
    const recoveryRecord = await this.database.$transaction(async (transaction) => {
      await transaction.strategySignalRecord.updateMany({
        where: { state: 'ACTIVE', expiresAt: { lte: now } },
        data: {
          state: 'EXPIRED',
          invalidatedAt: now,
          invalidationReason: 'Expired while runtime was offline',
        },
      });
      await transaction.distributedLock.deleteMany({ where: { expiresAt: { lte: now } } });
      await transaction.scannerExecutionRecord.updateMany({
        where: { status: 'RUNNING' },
        data: { status: 'FAILED', finishedAt: now },
      });
      await transaction.backtestJobRecord.updateMany({
        where: { status: { in: ['QUEUED', 'RUNNING', 'CANCELING'] } },
        data: {
          status: 'FAILED',
          finishedAt: now,
          error: 'RUNTIME_RESTART_INTERRUPTED_JOB',
        },
      });
      await transaction.tradeIntentRecord.updateMany({
        where: {
          state: { in: ['CREATED', 'VALIDATING', 'APPROVED', 'EXECUTING'] },
          orders: { none: {} },
        },
        data: {
          state: 'REJECTED',
          rejectionReasons: ['RUNTIME_RESTART_BEFORE_SUBMISSION'],
        },
      });
      return transaction.recoveryRecord.create({
        data: {
          trigger: 'STARTUP',
          mode: plan.mode,
          actions: toJsonValue(plan.actions),
          automaticResumeAllowed: false,
          startedAt: now,
        },
      });
    });
    return recoveryRecord.id;
  }

  private async completeRecovery(
    recoveryId: string,
    reconciliation: ReconciliationResult,
  ): Promise<void> {
    const unresolvedUnknownOrders = await this.database.orderRecord.count({
      where: { state: 'UNKNOWN' },
    });
    const automaticResumeAllowed =
      unresolvedUnknownOrders === 0 && this.recovery.canResumeAfterReconciliation(reconciliation);
    await this.database.recoveryRecord.update({
      where: { id: recoveryId },
      data: {
        mode: automaticResumeAllowed ? 'READY' : 'BLOCKED',
        automaticResumeAllowed,
        finishedAt: new Date(),
      },
    });
  }

  private assertBrokerEnabled(): void {
    if (this.stopping)
      throw new AppError('RUNTIME_STOPPING', 'Runtime is stopping', 503, 'DEPENDENCY', 'WARNING');
    if (!this.config.trading.brokerConnectivityEnabled)
      throw new AppError(
        'BROKER_CONNECTIVITY_DISABLED',
        'Broker connectivity is disabled',
        503,
        'CONFIGURATION',
        'WARNING',
      );
  }

  private trackCritical<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping)
      return Promise.reject(
        new AppError('RUNTIME_STOPPING', 'Runtime is stopping', 503, 'DEPENDENCY', 'WARNING'),
      );
    const promise = operation();
    this.criticalOperations.add(promise);
    void promise.finally(() => this.criticalOperations.delete(promise)).catch(() => undefined);
    return promise;
  }

  private async waitForCriticalOperations(timeoutMs: number): Promise<boolean> {
    if (this.criticalOperations.size === 0) return true;
    let timedOut = false;
    await Promise.race([
      Promise.allSettled([...this.criticalOperations]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        timer.unref();
      }),
    ]);
    return !timedOut;
  }

  private async syncAssetCatalog(): Promise<void> {
    const assets = await this.readTrading.listAssets();
    for (const asset of assets)
      await this.database.assetRecord.upsert({
        where: { symbol: asset.symbol },
        create: {
          id: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          assetClass: asset.asset_class,
          exchange: asset.exchange,
          status: asset.status,
          tradable: asset.tradable,
          fractionable: asset.fractionable,
          shortable: asset.shortable,
          marginable: asset.marginable,
          attributes: asset.attributes,
          brokerUpdatedAt: new Date(),
        },
        update: {
          name: asset.name,
          exchange: asset.exchange,
          status: asset.status,
          tradable: asset.tradable,
          fractionable: asset.fractionable,
          shortable: asset.shortable,
          marginable: asset.marginable,
          attributes: asset.attributes,
          brokerUpdatedAt: new Date(),
        },
      });
  }

  private async syncStrategyVersions(): Promise<void> {
    const now = new Date();
    for (const strategy of this.strategyEngine.getActive()) {
      const buildChecksum = sha256(
        JSON.stringify({
          strategyId: strategy.id,
          version: strategy.version,
          parameters: strategy.parameters,
          releaseSha: this.config.trading.releaseSha,
        }),
      );
      await this.database.strategyVersionRecord.upsert({
        where: { strategyId_version: { strategyId: strategy.id, version: strategy.version } },
        create: {
          strategyId: strategy.id,
          version: strategy.version,
          configurationVersion: strategy.configurationVersion,
          deploymentId: strategy.deploymentId,
          lifecycle: strategy.lifecycle,
          timeframe: strategy.timeframe,
          sessionPolicy: strategy.sessionPolicy,
          overnightPolicy: strategy.overnightPolicy,
          eventRiskPolicy: strategy.eventRiskPolicy,
          commitSha: this.config.trading.releaseSha,
          buildChecksum,
          parameters: toJsonValue(strategy.parameters),
          requiredIndicators: toJsonValue(strategy.requiredIndicators),
          ...(strategy.assetOverrides
            ? { assetOverrides: toJsonValue(strategy.assetOverrides) }
            : {}),
          cooldownMs: strategy.cooldownMs,
          maximumSignalsPerDay: strategy.maximumSignalsPerDay,
          maximumTradesPerDay: strategy.maximumTradesPerDay,
          activatedAt: now,
        },
        update: {
          lifecycle: strategy.lifecycle,
          commitSha: this.config.trading.releaseSha,
          buildChecksum,
        },
      });
    }
  }

  private async syncCorporateActions(): Promise<void> {
    const now = new Date();
    const symbols = await this.activeSymbols();
    if (symbols.length === 0) return;
    const records = await this.corporateActions.list(
      new Date(now.getTime() - 7 * 86_400_000),
      new Date(now.getTime() + 30 * 86_400_000),
      symbols,
    );
    for (const wire of records) {
      const action = corporateActionFromWire(wire.category, wire.value);
      if (!action || !symbols.includes(action.symbol)) continue;
      const [positions, orders] = await Promise.all([
        this.database.managedPositionRecord.findMany({
          where: { symbol: action.symbol, closedAt: null },
        }),
        this.database.orderRecord.findMany({
          where: {
            symbol: action.symbol,
            state: {
              in: [
                'SUBMITTING',
                'SUBMITTED',
                'ACCEPTED',
                'PARTIALLY_FILLED',
                'CANCEL_PENDING',
                'UNKNOWN',
              ],
            },
          },
        }),
      ]);
      const plan = this.corporateActionService.plan(
        action,
        positions.map((position) => ({
          id: position.id,
          symbol: position.symbol,
          quantity: position.remainingQuantity.toFixed(),
          costBasis: position.averageEntryPrice.mul(position.remainingQuantity).toFixed(),
        })),
        orders.map((order) => ({ id: order.id, symbol: order.symbol, status: order.state })),
      );
      await this.database.corporateActionRecord.upsert({
        where: { id: action.id },
        create: {
          id: action.id,
          type: action.type,
          state: plan.automaticallySafe ? 'PENDING' : 'AMBIGUOUS',
          symbol: action.symbol,
          ...(action.newSymbol ? { newSymbol: action.newSymbol } : {}),
          effectiveAt: action.effectiveAt,
          ...(action.quantityRatio ? { quantityRatio: action.quantityRatio } : {}),
          ...(action.cashAmount ? { cashAmount: action.cashAmount } : {}),
          raw: toJsonValue(action.raw),
          adjustments: {
            create: plan.positionAdjustments.map((adjustment) => ({
              entityType: adjustment.entityType,
              entityId: adjustment.entityId,
              operation: adjustment.operation,
              before: toJsonValue(adjustment.before),
              after: toJsonValue(adjustment.after),
            })),
          },
        },
        update: {
          // Corporate actions are immutable ledger events. In particular, never
          // move a RECONCILED action back to PENDING during the periodic sync or
          // the quantity/basis adjustment could be applied more than once.
          raw: toJsonValue(action.raw),
        },
      });
      if (action.type === 'CASH_DIVIDEND' || action.type === 'STOCK_DIVIDEND')
        await this.database.marketEventRecord.upsert({
          where: { id: `corporate-action:${action.id}` },
          create: {
            id: `corporate-action:${action.id}`,
            symbol: action.symbol,
            type: 'DIVIDEND',
            scheduledAt: action.effectiveAt,
            timing: 'UNKNOWN',
            source: 'alpaca-corporate-actions',
            sourceVersion: this.config.trading.releaseSha,
            raw: toJsonValue(action.raw),
          },
          update: { scheduledAt: action.effectiveAt, raw: toJsonValue(action.raw) },
        });
      const shouldBlock =
        !plan.automaticallySafe || action.effectiveAt.getTime() <= now.getTime() + 2 * 86_400_000;
      if (shouldBlock) {
        const asset = await this.database.assetRecord.findUnique({
          where: { symbol: action.symbol },
        });
        if (asset) {
          const reason = `CORPORATE_ACTION_${action.type}_${action.id}`;
          const existing = await this.database.symbolBlockRecord.findFirst({
            where: { assetId: asset.id, reason, releasedAt: null },
          });
          if (!existing)
            await this.database.symbolBlockRecord.create({
              data: {
                assetId: asset.id,
                reason,
                source: 'alpaca-corporate-actions',
                blockedAt: now,
              },
            });
        }
      }
    }
  }

  private async applyVerifiedCorporateActions(
    brokerPositions: Awaited<ReturnType<AlpacaTradingClient['listPositions']>>,
  ): Promise<void> {
    const now = new Date();
    const actions = await this.database.corporateActionRecord.findMany({
      where: {
        state: { in: ['PENDING', 'EFFECTIVE', 'RECONCILING'] },
        effectiveAt: { lte: now },
      },
      orderBy: { effectiveAt: 'asc' },
    });
    for (const action of actions) {
      const local = await this.database.managedPositionRecord.findFirst({
        where: { symbol: action.symbol, closedAt: null },
      });
      let verified = false;
      if (!local) {
        verified = !brokerPositions.some(
          (position) => position.symbol === action.symbol || position.symbol === action.newSymbol,
        );
      } else if (
        ['FORWARD_SPLIT', 'REVERSE_SPLIT', 'STOCK_DIVIDEND'].includes(action.type) &&
        action.quantityRatio?.gt(0)
      ) {
        const broker = brokerPositions.find((position) => position.symbol === action.symbol);
        const expectedQuantity = local.remainingQuantity.mul(action.quantityRatio);
        const expectedAverage = local.averageEntryPrice.div(action.quantityRatio);
        verified =
          !!broker &&
          new Decimal(broker.qty).minus(expectedQuantity).abs().lte('0.000001') &&
          new Decimal(broker.avg_entry_price).minus(expectedAverage).abs().lte('0.01');
        if (verified)
          await this.database.$transaction([
            this.database.managedPositionRecord.update({
              where: { id: local.id },
              data: {
                quantity: local.quantity.mul(action.quantityRatio),
                remainingQuantity: expectedQuantity,
                averageEntryPrice: expectedAverage,
                highWaterPrice: local.highWaterPrice.div(action.quantityRatio),
                ...(local.stopLossPrice
                  ? { stopLossPrice: local.stopLossPrice.div(action.quantityRatio) }
                  : {}),
                ...(local.takeProfitPrice
                  ? { takeProfitPrice: local.takeProfitPrice.div(action.quantityRatio) }
                  : {}),
              },
            }),
            this.database.taxLotRecord.updateMany({
              where: { symbol: action.symbol, remainingQuantity: { gt: 0 } },
              data: {
                originalQuantity: { multiply: action.quantityRatio },
                remainingQuantity: { multiply: action.quantityRatio },
                acquisitionPrice: { divide: action.quantityRatio },
                basisPerShare: { divide: action.quantityRatio },
              },
            }),
          ]);
      } else if (['SYMBOL_CHANGE', 'NAME_CHANGE'].includes(action.type) && action.newSymbol) {
        const broker = brokerPositions.find((position) => position.symbol === action.newSymbol);
        verified = !!broker && new Decimal(broker.qty).eq(local.remainingQuantity);
        if (verified)
          await this.database.$transaction([
            this.database.managedPositionRecord.update({
              where: { id: local.id },
              data: { symbol: action.newSymbol },
            }),
            this.database.strategyPositionBindingRecord.updateMany({
              where: { symbol: action.symbol, active: true },
              data: { symbol: action.newSymbol },
            }),
            this.database.taxLotRecord.updateMany({
              where: { symbol: action.symbol, remainingQuantity: { gt: 0 } },
              data: { symbol: action.newSymbol },
            }),
            this.database.orderRecord.updateMany({
              where: {
                symbol: action.symbol,
                state: {
                  in: ['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_PENDING'],
                },
              },
              data: { symbol: action.newSymbol },
            }),
            this.database.protectionGroupRecord.updateMany({
              where: { symbol: action.symbol, state: 'ACTIVE' },
              data: { symbol: action.newSymbol },
            }),
          ]);
      } else if (action.type === 'CASH_DIVIDEND') {
        verified = true;
      }
      await this.database.corporateActionRecord.update({
        where: { id: action.id },
        data: { state: verified ? 'RECONCILED' : 'RECONCILING' },
      });
      if (verified)
        await this.database.symbolBlockRecord.updateMany({
          where: {
            reason: `CORPORATE_ACTION_${action.type}_${action.id}`,
            releasedAt: null,
          },
          data: { releasedAt: now },
        });
    }
  }

  private async refreshCalendarAndClock(): Promise<void> {
    const now = new Date();
    const from = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    await this.calendar.refresh(from, to);
    const clock = await this.calendar.clock();
    const brokerTime = new Date(clock.timestamp);
    const skew = Math.abs(Date.now() - brokerTime.getTime());
    await this.database.marketClockRecord.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        isOpen: clock.is_open,
        session: this.calendar.sessionAt(brokerTime),
        brokerTime,
        nextOpen: new Date(clock.next_open),
        nextClose: new Date(clock.next_close),
        observedAt: now,
      },
      update: {
        isOpen: clock.is_open,
        session: this.calendar.sessionAt(brokerTime),
        brokerTime,
        nextOpen: new Date(clock.next_open),
        nextClose: new Date(clock.next_close),
        observedAt: now,
      },
    });
    if (skew > this.config.app.maxClockSkewMs) throw new Error(`CLOCK_SKEW_EXCEEDED:${skew}`);
  }

  private async activeSymbols(): Promise<string[]> {
    const [watchlist, positions, orders] = await Promise.all([
      this.database.watchlistRecord.findMany({
        where: { active: true },
        include: { asset: true },
      }),
      this.database.managedPositionRecord.findMany({
        where: { closedAt: null },
        select: { symbol: true },
      }),
      this.database.orderRecord.findMany({
        where: {
          state: {
            in: [
              'SUBMITTING',
              'SUBMITTED',
              'ACCEPTED',
              'PARTIALLY_FILLED',
              'CANCEL_PENDING',
              'UNKNOWN',
            ],
          },
        },
        select: { symbol: true },
      }),
    ]);
    return [
      ...new Set([
        ...watchlist.map((record) => record.asset.symbol),
        ...positions.map((position) => position.symbol),
        ...orders.map((order) => order.symbol),
      ]),
    ].sort();
  }

  private async recordStreamFreshness(
    symbol: string,
    kind: 'bar' | 'quote' | 'trade',
    timestamp: Date,
  ): Promise<void> {
    const field =
      kind === 'bar'
        ? { lastBarAt: timestamp }
        : kind === 'quote'
          ? { lastQuoteAt: timestamp }
          : { lastTradeAt: timestamp };
    await this.database.marketDataStateRecord.upsert({
      where: { symbol },
      create: { symbol, health: 'UNAVAILABLE', ...field },
      update: field,
    });
  }

  private async handleMarketStreamDisconnect(
    symbols: readonly string[],
    disconnectedAt: Date,
  ): Promise<void> {
    for (const symbol of symbols) this.marketHealth.markUnavailable(symbol);
    await this.database.marketDataStateRecord.updateMany({
      where: { symbol: { in: [...symbols] } },
      data: {
        health: 'UNAVAILABLE',
        warmupBarsObserved: 0,
        warmupCompletedAt: null,
        reason: 'WEBSOCKET_DISCONNECTED',
      },
    });
    await this.safety.block({
      scope: 'GLOBAL',
      reason: 'INVALID_MARKET_DATA',
      detail: `Market stream disconnected at ${disconnectedAt.toISOString()}`,
      at: disconnectedAt,
      cooldownMs: 60_000,
    });
    await this.raiseAlert({
      kind: 'MARKET_DATA_DOWN',
      severity: 'CRITICAL',
      title: 'Realtime market data disconnected',
      message: `Streaming disconnected at ${disconnectedAt.toISOString()}; entries are blocked`,
      component: 'market-stream',
      scope: symbols.join(',') || 'global',
      metadata: { symbols },
    });
  }

  private async recoverMarketStream(
    symbols: readonly string[],
    disconnectedAt: Date,
    reconnectedAt: Date,
  ): Promise<void> {
    await Promise.all(symbols.map((symbol) => this.loadValidatedMarketData(symbol)));
    await this.reconcile('RECONNECT', randomUUID());
    await this.database.marketDataStateRecord.updateMany({
      where: { symbol: { in: [...symbols] }, health: 'HEALTHY' },
      data: {
        reason: null,
        recoveryEvidence: toJsonValue({
          source: 'websocket-reconnect-backfill',
          disconnectedAt,
          reconnectedAt,
          reconciliation: 'completed',
        }),
      },
    });
  }

  private async loadValidatedMarketData(symbol: string): Promise<ValidatedMarketData> {
    const now = new Date();
    const timeframe = this.config.runtime.marketDataTimeframe;
    const end = new Date(now.getTime() - timeframeMilliseconds(timeframe));
    const start = new Date(end.getTime() - 10 * 86_400_000);
    const [bars, quotes, trades, position, event] = await Promise.all([
      this.marketData.getHistoricalBars({ symbols: [symbol], timeframe, start, end }),
      this.marketData.getLatestQuotes([symbol]),
      this.marketData.getLatestTrades([symbol]),
      this.database.managedPositionRecord.findFirst({ where: { symbol, closedAt: null } }),
      this.database.marketEventRecord.findFirst({
        where: {
          OR: [{ symbol }, { symbol: null }],
          scheduledAt: {
            gte: new Date(now.getTime() - 60 * 60_000),
            lte: new Date(now.getTime() + 24 * 60 * 60_000),
          },
        },
        orderBy: { scheduledAt: 'asc' },
      }),
    ]);
    const quote = quotes[0];
    if (!quote) throw new Error('LATEST_QUOTE_UNAVAILABLE');
    const validation = this.marketValidator.validateBars(symbol, timeframe, bars, {
      maximumAgeMs: this.config.runtime.marketDataMaxAgeMs,
      futureToleranceMs: 1_000,
      maximumGapMultiplier: 1,
      maximumPriceChangeFraction: 0.5,
      minimumBars: this.config.runtime.marketDataWarmupBars,
      isExpectedBarTime: (timestamp) => this.calendar.isExpectedBarTime(timestamp, timeframe, true),
    });
    const quoteFresh =
      now.getTime() - quote.timestamp.getTime() <= this.config.runtime.marketDataMaxAgeMs;
    const trade = trades[0];
    const tradeFresh =
      !!trade &&
      now.getTime() - trade.timestamp.getTime() <= this.config.runtime.marketDataMaxAgeMs;
    const health =
      validation.health === 'HEALTHY' && quoteFresh && tradeFresh
        ? 'HEALTHY'
        : validation.health === 'INCONSISTENT'
          ? 'INCONSISTENT'
          : 'STALE';
    const observed = Math.min(bars.length, this.config.runtime.marketDataWarmupBars);
    this.marketHealth.recordValidation(
      symbol,
      { ...validation, health },
      this.config.runtime.marketDataWarmupBars,
    );
    await this.database.marketDataStateRecord.upsert({
      where: { symbol },
      create: {
        symbol,
        health,
        ...(validation.lastValidTimestamp
          ? {
              lastValidTimestamp: validation.lastValidTimestamp,
              lastBarAt: validation.lastValidTimestamp,
            }
          : {}),
        lastQuoteAt: quote.timestamp,
        ...(trade ? { lastTradeAt: trade.timestamp } : {}),
        warmupBarsObserved: observed,
        ...(health === 'HEALTHY' ? { warmupCompletedAt: now } : {}),
        recoveryEvidence: {
          quoteFresh,
          tradeFresh,
          anomalies: validation.anomalies.map((item) => item.code),
        },
      },
      update: {
        health,
        lastValidTimestamp: validation.lastValidTimestamp ?? null,
        lastBarAt: validation.lastValidTimestamp ?? null,
        lastQuoteAt: quote.timestamp,
        lastTradeAt: trade?.timestamp ?? null,
        warmupBarsObserved: observed,
        warmupCompletedAt: health === 'HEALTHY' ? now : null,
        recoveryEvidence: {
          quoteFresh,
          tradeFresh,
          anomalies: validation.anomalies.map((item) => item.code),
        },
      },
    });
    for (const anomaly of validation.anomalies)
      await this.database.marketDataAnomalyRecord.create({
        data: {
          symbol,
          code: anomaly.code,
          severity: anomaly.severity,
          detail: anomaly.detail,
          ...(anomaly.timestamp ? { dataTime: anomaly.timestamp } : {}),
          detectedAt: now,
        },
      });
    return {
      bars,
      quote,
      validation: { ...validation, health },
      hasOpenPosition: position !== null,
      ...(position ? { positionStrategyVersion: position.strategyVersion } : {}),
      eventRisk: event ? 'BLOCKED' : 'NONE',
    };
  }

  private marketRejections(symbol: string, data: ValidatedMarketData): readonly string[] {
    const reasons: string[] = [];
    if (data.validation.health !== 'HEALTHY') reasons.push(`MARKET_DATA_${data.validation.health}`);
    if (!this.haltService.canOpen(symbol) && this.haltService.current(symbol))
      reasons.push('SYMBOL_HALTED_OR_UNKNOWN');
    return reasons;
  }

  private buildContextSync(symbol: string, data: ValidatedMarketData, _now: Date): StrategyContext {
    const bars = data.bars;
    const closes = bars.map((bar) => bar.close);
    const fast = ema(closes, 20);
    const slow = ema(closes, 50);
    const strength = adx(bars, 14).adx;
    const rsiValues = rsi(closes, 14);
    const bands = bollingerBands(closes, 20, 2);
    const atrValues = atr(bars, 14);
    const volumeAverage = averageVolume(bars.slice(0, -1), 20);
    const volatility = rollingVolatility(closes, 20, 252 * 390);
    const lastBar = bars.at(-1);
    if (lastBar === undefined) throw new Error(`Missing validated market bars for ${symbol}`);
    const previous = bars.slice(-21, -1);
    const average = latest(volumeAverage, (value) => value);
    const indicators: Record<string, number | null> = {
      'ema.fast': latest(fast, (value) => value),
      'ema.slow': latest(slow, (value) => value),
      adx: latest(strength, (value) => value),
      rsi: latest(rsiValues, (value) => value),
      'bollinger.lower': latest(bands.lower, (value) => value),
      'bollinger.middle': latest(bands.middle, (value) => value),
      atr: latest(atrValues, (value) => value),
      'average.volume': average,
      'volume.ratio': average && average > 0 ? lastBar.volume / average : null,
      'rolling.high': previous.length ? Math.max(...previous.map((bar) => bar.high)) : null,
      volatility: latest(volatility, (value) => value),
    };
    return {
      symbol,
      timestamp: new Date(lastBar.timestamp),
      timeframe: this.config.runtime.marketDataTimeframe,
      price: (data.quote.bidPrice + data.quote.askPrice) / 2,
      indicators,
      hasOpenPosition: data.hasOpenPosition,
      ...(data.positionStrategyVersion
        ? { positionStrategyVersion: data.positionStrategyVersion }
        : {}),
      eventRisk: data.eventRisk,
    };
  }

  private async routeCandidate(candidate: ScanCandidate, executionId: string) {
    const signal = candidate.signal;
    await this.journal(executionId, 'SIGNAL', {
      signalId: signal.id,
      symbol: signal.symbol,
      type: signal.type,
      strategyId: signal.strategyId,
      strategyVersion: signal.strategyVersion,
    });
    await this.journal(executionId, 'CANDIDATE', {
      signalId: signal.id,
      rank: candidate.rank,
      score: candidate.score,
    });
    if (signal.type === 'EXIT' || signal.type === 'SELL') {
      const position = await this.database.managedPositionRecord.findFirst({
        where: { symbol: signal.symbol, closedAt: null },
      });
      if (!position)
        return {
          symbol: signal.symbol,
          strategyId: signal.strategyId,
          code: 'POSITION_NOT_FOUND',
          reason: 'Exit signal has no open position',
        };
      const result = await this.closePosition(position.id, {
        actor: 'scanner',
        correlationId: executionId,
      });
      return result
        ? undefined
        : {
            symbol: signal.symbol,
            strategyId: signal.strategyId,
            code: 'EXIT_FAILED',
            reason: 'Exit pipeline failed',
          };
    }
    const strategy = this.strategyEngine
      .getActive()
      .find(
        (definition) =>
          definition.id === signal.strategyId && definition.version === signal.strategyVersion,
      );
    if (!strategy)
      return {
        symbol: signal.symbol,
        strategyId: signal.strategyId,
        code: 'STRATEGY_VERSION_NOT_ACTIVE',
        reason: 'The signal strategy version is no longer active',
      };
    const entriesToday = await this.database.tradeIntentRecord.count({
      where: {
        strategyId: signal.strategyId,
        strategyVersion: signal.strategyVersion,
        createdAt: { gte: startOfMarketDay(new Date()) },
        state: { in: ['SUBMITTED', 'COMPLETED'] },
      },
    });
    if (entriesToday >= strategy.maximumTradesPerDay)
      return {
        symbol: signal.symbol,
        strategyId: signal.strategyId,
        code: 'STRATEGY_DAILY_TRADE_LIMIT',
        reason: `Daily strategy limit of ${strategy.maximumTradesPerDay} entries reached`,
      };
    const intent = await this.createIntent(signal, executionId, 'buy', 'bracket');
    await this.journal(
      executionId,
      'TRADE_INTENT',
      { intentId: intent.id, side: 'buy', orderClass: 'bracket' },
      intent.id,
    );
    const result = await this.executor.execute(intent);
    await this.journal(executionId, 'ORDER', { intentId: intent.id, result }, intent.id);
    if (result.intentState === 'REJECTED' || result.intentState === 'UNKNOWN')
      return {
        symbol: signal.symbol,
        strategyId: signal.strategyId,
        code: result.intentState,
        reason: result.reasons.join(', ') || result.intentState,
      };
    return undefined;
  }

  private async createIntent(
    signal: StrategySignal,
    correlationId: string,
    side: 'buy' | 'sell',
    orderClass: 'simple' | 'bracket',
  ): Promise<TradeIntent> {
    const price = new Decimal(await this.referencePrice(signal.symbol));
    const id = randomUUID();
    return {
      id,
      deduplicationKey: sha256(`intent:${signal.deduplicationKey}:${side}`),
      signal,
      specification: {
        side,
        type: 'market',
        timeInForce: 'day',
        orderClass,
        ...(orderClass === 'bracket'
          ? {
              stopLossPrice: price.mul('0.98'),
              takeProfitPrice: price.mul('1.04'),
            }
          : {}),
        extendedHours: false,
        pricePrecision: price.gte(1) ? 2 : 4,
        maximumPriceDeviationBps: 100,
      },
      createdAt: new Date(),
      correlationId,
      immutableConfigurationSnapshot: {
        tradingMode: this.config.trading.mode,
        releaseSha: this.config.trading.releaseSha,
        deploymentId: this.config.trading.deploymentId,
      },
    };
  }

  private async referencePrice(symbol: string): Promise<Decimal> {
    const quote = (await this.marketData.getLatestQuotes([symbol]))[0];
    if (!quote) throw new Error('REFERENCE_QUOTE_UNAVAILABLE');
    if (Date.now() - quote.timestamp.getTime() > this.config.runtime.marketDataMaxAgeMs)
      throw new Error('REFERENCE_QUOTE_STALE');
    const price = new Decimal(quote.bidPrice).plus(quote.askPrice).div(2);
    if (!price.gt(0)) throw new Error('REFERENCE_PRICE_INVALID');
    return price;
  }

  private async recalculateSizing(intent: TradeIntent): Promise<PositionSizingResult> {
    if (intent.signal.type === 'EXIT' || intent.specification.side === 'sell') {
      const position = await this.database.managedPositionRecord.findFirst({
        where: { symbol: intent.signal.symbol, closedAt: null },
      });
      const quantity = new Decimal(position?.remainingQuantity ?? 0);
      const price = new Decimal(await this.referencePrice(intent.signal.symbol));
      return {
        approved: quantity.gt(0),
        quantity,
        roundedEntryPrice: price,
        notional: quantity.mul(price),
        monetaryRisk: new Decimal(0),
        riskPercent: new Decimal(0),
        stopDistance: new Decimal(0),
        reasons: quantity.gt(0) ? [] : ['POSITION_NOT_OPEN'],
        calculation: { exitPositionId: position?.id ?? 'missing' },
      };
    }
    const [account, asset, positions, orders, price, risk] = await Promise.all([
      this.readTrading.getAccount(),
      this.readTrading.getAsset(intent.signal.symbol),
      this.readTrading.listPositions(),
      this.readTrading.listOrders('open'),
      this.referencePrice(intent.signal.symbol),
      this.activeRisk(),
    ]);
    const existing = positions.find((position) => position.symbol === intent.signal.symbol);
    const pending = orders
      .filter((order) => order.symbol === intent.signal.symbol)
      .reduce(
        (sum, order) =>
          sum.plus(
            new Decimal(order.qty ?? 0)
              .minus(order.filled_qty)
              .abs()
              .mul(order.limit_price ?? price),
          ),
        new Decimal(0),
      );
    return sizePosition(
      {
        symbol: intent.signal.symbol,
        equity: account.equity,
        cash: account.cash,
        buyingPower: account.buying_power,
        entryPrice: price,
        ...(intent.specification.stopLossPrice === undefined
          ? {}
          : { stopPrice: intent.specification.stopLossPrice }),
        existingExposure: new Decimal(existing?.market_value ?? 0).abs(),
        pendingExposure: pending,
        minimumQuantity: asset.fractionable ? '0.000001' : '1',
        fractionable: asset.fractionable,
        quantityPrecision: asset.fractionable ? 6 : 0,
        pricePrecision: price.gte(1) ? 2 : 4,
      },
      risk,
    );
  }

  private async finalValidate(intent: TradeIntent): Promise<readonly string[]> {
    const reasons: string[] = [];
    const exit = intent.signal.type === 'EXIT' || intent.specification.side === 'sell';
    const [account, asset, clock, market, reconciliation, unknownOrders] = await Promise.all([
      this.readTrading.getAccount(),
      this.readTrading.getAsset(intent.signal.symbol),
      this.calendar.clock(),
      this.database.marketDataStateRecord.findUnique({ where: { symbol: intent.signal.symbol } }),
      this.database.reconciliationRecord.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.database.orderRecord.count({ where: { state: 'UNKNOWN' } }),
    ]);
    if (!accountTradeable(account)) reasons.push('ACCOUNT_NOT_TRADEABLE');
    if (!asset.tradable || asset.status !== 'active') reasons.push('ASSET_NOT_TRADABLE');
    if (!clock.is_open) reasons.push('MARKET_CLOSED');
    if (intent.signal.expiresAt <= new Date()) reasons.push('SIGNAL_EXPIRED');
    if (!exit) {
      if (market?.health !== 'HEALTHY') reasons.push('MARKET_DATA_NOT_HEALTHY');
      if (
        !market?.lastQuoteAt ||
        Date.now() - market.lastQuoteAt.getTime() > this.config.runtime.marketDataMaxAgeMs
      )
        reasons.push('QUOTE_STALE');
      if (!reconciliation || !['MATCHED', 'CORRECTED'].includes(reconciliation.state))
        reasons.push('RECONCILIATION_NOT_HEALTHY');
      if (
        !reconciliation?.finishedAt ||
        Date.now() - reconciliation.finishedAt.getTime() >
          this.config.runtime.reconciliationIntervalMs * 2
      )
        reasons.push('RECONCILIATION_STALE');
      if (unknownOrders > 0) reasons.push('UNKNOWN_ORDER_EXISTS');
      if (
        !this.haltService.canOpen(intent.signal.symbol) &&
        this.haltService.current(intent.signal.symbol)
      )
        reasons.push('SYMBOL_HALTED');
    }
    return reasons;
  }

  private async finalRisk(
    intent: TradeIntent,
    sizing: PositionSizingResult,
  ): Promise<RiskDecision> {
    const now = new Date();
    if (intent.signal.type === 'EXIT' || intent.specification.side === 'sell') {
      const decision: RiskDecision = {
        id: randomUUID(),
        outcome:
          sizing.approved && this.safety.canExit(this.config.trading.mode)
            ? 'APPROVED'
            : 'REJECTED',
        signalId: intent.signal.id,
        symbol: intent.signal.symbol,
        evaluatedAt: now,
        reasonCodes: sizing.approved ? [] : sizing.reasons,
        configurationSnapshotId: (await this.activeRisk()).id,
        decisionSnapshot: {
          exit: true,
          quantity: sizing.quantity.toFixed(),
          mode: this.config.trading.mode,
        },
      };
      await this.database.riskDecisionRecord.create({
        data: {
          id: decision.id,
          signalId: decision.signalId,
          symbol: decision.symbol,
          outcome: decision.outcome,
          reasonCodes: [...decision.reasonCodes],
          riskConfigurationId: decision.configurationSnapshotId,
          decisionSnapshot: { ...decision.decisionSnapshot },
          evaluatedAt: decision.evaluatedAt,
        },
      });
      return decision;
    }
    const [
      account,
      asset,
      brokerPositions,
      brokerOrders,
      quote,
      risk,
      data,
      dailyTradeCount,
      dailyStrategyTradeCount,
      dailyPnl,
      latestEquity,
      managedPositions,
    ] = await Promise.all([
      this.readTrading.getAccount(),
      this.readTrading.getAsset(intent.signal.symbol),
      this.readTrading.listPositions(),
      this.readTrading.listOrders('open'),
      this.marketData.getLatestQuotes([intent.signal.symbol]),
      this.activeRisk(),
      this.loadValidatedMarketData(intent.signal.symbol),
      this.database.orderRecord.count({
        where: {
          side: 'buy',
          parentOrderId: null,
          createdAt: { gte: startOfMarketDay(now) },
          state: {
            in: [
              'SUBMITTED',
              'ACCEPTED',
              'PARTIALLY_FILLED',
              'FILLED',
              'CANCEL_PENDING',
              'CANCELED',
            ],
          },
        },
      }),
      this.database.tradeIntentRecord.count({
        where: {
          id: { not: intent.id },
          strategyId: intent.signal.strategyId,
          strategyVersion: intent.signal.strategyVersion,
          createdAt: { gte: startOfMarketDay(now) },
          state: { in: ['SUBMITTED', 'COMPLETED'] },
        },
      }),
      this.database.lotDispositionRecord.aggregate({
        where: { soldAt: { gte: startOfMarketDay(now) } },
        _sum: { realizedPnl: true },
      }),
      this.database.equityCurvePointRecord.findFirst({ orderBy: { capturedAt: 'desc' } }),
      this.database.managedPositionRecord.findMany({ where: { closedAt: null } }),
    ]);
    const q = quote[0];
    const mid = q ? new Decimal(q.bidPrice).plus(q.askPrice).div(2) : new Decimal(0);
    const spreadBps =
      q && mid.gt(0)
        ? new Decimal(q.askPrice).minus(q.bidPrice).div(mid).mul(10_000)
        : new Decimal(Infinity);
    const currentGlobal = brokerPositions.reduce(
      (sum, position) => sum.plus(new Decimal(position.market_value).abs()),
      new Decimal(0),
    );
    const currentAsset = new Decimal(
      brokerPositions.find((position) => position.symbol === intent.signal.symbol)?.market_value ??
        0,
    ).abs();
    const pendingAsset = brokerOrders
      .filter((order) => order.symbol === intent.signal.symbol)
      .reduce(
        (sum, order) =>
          sum.plus(
            new Decimal(order.qty ?? 0)
              .minus(order.filled_qty)
              .abs()
              .mul(order.limit_price ?? mid),
          ),
        new Decimal(0),
      );
    const concentration = new Decimal(account.equity).gt(0)
      ? Decimal.max(
          0,
          ...brokerPositions.map((position) => new Decimal(position.market_value).abs()),
        )
          .div(account.equity)
          .mul(100)
      : new Decimal(Infinity);
    const dollarVolumes = data.bars
      .slice(-390)
      .map((bar) => new Decimal(bar.close).mul(bar.volume));
    const adv = dollarVolumes.reduce((sum, value) => sum.plus(value), new Decimal(0));
    const vol =
      latest(
        rollingVolatility(
          data.bars.map((bar) => bar.close),
          20,
          252 * 390,
        ),
        (value) => value,
      ) ?? Infinity;
    const restriction = new AccountRestrictionGuard().evaluate(
      account,
      asset,
      {
        side: intent.specification.side,
        notional: sizing.notional.toFixed(),
        wouldOpenOrIncrease: true,
        wouldDayTrade: true,
        isShortSale: false,
      },
      { buyingPower: account.buying_power, cash: account.cash, equity: account.equity },
    );
    const aggregateRisk = new Decimal(account.equity).gt(0)
      ? managedPositions
          .reduce((sum, position) => {
            if (position.stopLossPrice === null)
              return sum.plus(position.remainingQuantity.mul(position.averageEntryPrice));
            return sum.plus(
              position.averageEntryPrice
                .minus(position.stopLossPrice)
                .abs()
                .mul(position.remainingQuantity),
            );
          }, new Decimal(0))
          .div(account.equity)
          .mul(100)
      : new Decimal(Infinity);
    const decision = await this.riskGate.evaluate(
      {
        expectedMode: this.config.trading.mode,
        actualMode: this.safety.snapshot().tradingMode,
        tradingEnabled: this.safety.snapshot().tradingEnabled,
        systemReady: this.operationalState.current().state === 'READY',
        symbolValid: asset.tradable && asset.status === 'active',
        marketSessionOpen:
          this.calendar.sessionAt(now) === 'REGULAR' &&
          withinRiskSession(
            now,
            risk.configuration.allowedSessionStart,
            risk.configuration.allowedSessionEnd,
          ),
        marketDataHealth: data.validation.health,
        signal: intent.signal,
        now,
        positionSizing: sizing,
        equity: account.equity,
        cash: account.cash,
        buyingPower: account.buying_power,
        currentAssetExposure: currentAsset,
        currentGlobalExposure: currentGlobal,
        pendingAssetExposure: pendingAsset,
        projectedNotional: sizing.notional,
        currentConcentrationPercent: concentration,
        positionCount: brokerPositions.length,
        openOrderCount: brokerOrders.length,
        dailyTradeCount,
        dailyStrategyTradeCount,
        dailyPnl: dailyPnl._sum.realizedPnl ?? 0,
        drawdownPercent: latestEquity?.drawdownPercent ?? 0,
        aggregateRiskPercent: aggregateRisk,
        averageDailyDollarVolume: adv,
        spreadBps,
        annualizedVolatility: vol,
        quotePrice: mid,
        duplicateOperation:
          (await this.database.tradeIntentRecord.count({
            where: { deduplicationKey: intent.deduplicationKey, id: { not: intent.id } },
          })) > 0,
        regulatoryAllowed: restriction.approved,
        regulatoryReasons: restriction.reasons,
      },
      risk,
    );
    await this.journal(
      intent.correlationId,
      'RISK_DECISION',
      {
        riskDecisionId: decision.id,
        outcome: decision.outcome,
        reasonCodes: decision.reasonCodes,
        configurationSnapshotId: decision.configurationSnapshotId,
      },
      intent.id,
    );
    const dailyLossReached = decision.reasonCodes.some((code) =>
      ['DAILY_LOSS_LIMIT_REACHED', 'ABSOLUTE_DAILY_LOSS_LIMIT_REACHED'].includes(code),
    );
    const drawdownReached = decision.reasonCodes.includes('MAXIMUM_DRAWDOWN_REACHED');
    if (dailyLossReached || drawdownReached) {
      await this.safety.block({
        scope: 'GLOBAL',
        reason: dailyLossReached ? 'DAILY_LOSS' : 'DRAWDOWN',
        detail: decision.reasonCodes.join(', '),
        at: now,
        cooldownMs: 24 * 60 * 60_000,
      });
      await this.raiseAlert({
        kind: dailyLossReached ? 'DAILY_LOSS_REACHED' : 'DRAWDOWN_REACHED',
        severity: 'EMERGENCY',
        title: dailyLossReached ? 'Daily loss limit reached' : 'Maximum drawdown reached',
        message: `Entries blocked: ${decision.reasonCodes.join(', ')}`,
        component: 'risk',
        scope: 'global',
        correlationId: intent.correlationId,
      });
    }
    return decision;
  }

  private async activeRisk(): Promise<RiskConfigurationSnapshot> {
    const record = await this.database.riskConfigurationRecord.findFirst({
      where: { active: true },
      orderBy: { activatedAt: 'desc' },
    });
    if (!record) throw new Error('ACTIVE_RISK_CONFIGURATION_MISSING');
    const snapshot = createRiskConfigurationSnapshot(record.configuration, record.createdAt);
    if (snapshot.checksum !== record.checksum)
      throw new Error('RISK_CONFIGURATION_CHECKSUM_MISMATCH');
    return snapshot;
  }

  private async saveSignal(signal: StrategySignal): Promise<void> {
    await this.database.strategySignalRecord.upsert({
      where: { deduplicationKey: signal.deduplicationKey },
      create: {
        id: signal.id,
        symbol: signal.symbol,
        strategyId: signal.strategyId,
        strategyVersion: signal.strategyVersion,
        configurationVersion: signal.configurationVersion,
        deploymentId: signal.deploymentId,
        type: signal.type,
        reason: signal.reason,
        ...(signal.confidence === undefined ? {} : { confidence: signal.confidence }),
        ...(signal.expectedEdgeBps === undefined
          ? {}
          : { expectedEdgeBps: signal.expectedEdgeBps }),
        parametersSnapshot: toJsonValue(signal.parametersSnapshot),
        configurationSnapshot: toJsonValue(signal.configurationSnapshot),
        deduplicationKey: signal.deduplicationKey,
        signaledAt: signal.timestamp,
        expiresAt: signal.expiresAt,
      },
      update: {},
    });
  }

  private async findScan(key: string): Promise<ScannerExecution | undefined> {
    const scan = await this.database.scannerExecutionRecord.findUnique({
      where: { idempotencyKey: key },
      include: { results: true },
    });
    if (!scan?.finishedAt || scan.durationMs === null) return undefined;
    return {
      id: scan.id,
      idempotencyKey: scan.idempotencyKey,
      trigger: scan.trigger as ScannerExecution['trigger'],
      status: scan.status,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      durationMs: scan.durationMs,
      candidates: [],
      rejections: scan.results
        .filter((item) => !item.accepted)
        .map((item) => ({
          symbol: item.symbol,
          ...(item.strategyId ? { strategyId: item.strategyId } : {}),
          code: item.rejectionCode ?? 'REJECTED',
          reason: item.rejectionReason ?? 'Persisted rejection',
        })),
      symbolsProcessed: scan.symbolsProcessed,
      symbolsFailed: scan.symbolsFailed,
    };
  }

  private async saveScan(execution: ScannerExecution): Promise<void> {
    await this.database.scannerExecutionRecord.create({
      data: {
        id: execution.id,
        idempotencyKey: execution.idempotencyKey,
        trigger: execution.trigger,
        status: execution.status,
        symbolsProcessed: execution.symbolsProcessed,
        symbolsFailed: execution.symbolsFailed,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        durationMs: execution.durationMs,
        results: {
          create: [
            ...execution.candidates.map((candidate) => ({
              symbol: candidate.signal.symbol,
              strategyId: candidate.signal.strategyId,
              signalId: candidate.signal.id,
              accepted: true,
              rank: candidate.rank,
              score: candidate.score,
            })),
            ...execution.rejections.map((rejection) => ({
              symbol: rejection.symbol,
              ...(rejection.strategyId ? { strategyId: rejection.strategyId } : {}),
              accepted: false,
              rejectionCode: rejection.code,
              rejectionReason: rejection.reason,
            })),
          ],
        },
      },
    });
  }

  private async saveSchedulerState(snapshot: SchedulerSnapshot): Promise<void> {
    await this.database.schedulerStateRecord.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        state: snapshot.state,
        configurationId: snapshot.configuration.id,
        ...(snapshot.nextExecutionAt ? { nextExecutionAt: snapshot.nextExecutionAt } : {}),
        ...(snapshot.lastExecutionAt ? { lastExecutionAt: snapshot.lastExecutionAt } : {}),
        ...(snapshot.activeExecutionId ? { activeExecutionId: snapshot.activeExecutionId } : {}),
        workerId: this.instanceId,
        workerHeartbeatAt: new Date(),
      },
      update: {
        state: snapshot.state,
        configurationId: snapshot.configuration.id,
        nextExecutionAt: snapshot.nextExecutionAt ?? null,
        lastExecutionAt: snapshot.lastExecutionAt ?? null,
        activeExecutionId: snapshot.activeExecutionId ?? null,
        workerId: this.instanceId,
        workerHeartbeatAt: new Date(),
        version: { increment: 1 },
      },
    });
  }

  private async saveSchedulerExecution(execution: SchedulerExecution): Promise<void> {
    const scan = await this.database.scannerExecutionRecord.findUnique({
      where: { idempotencyKey: `scanner:${execution.idempotencyKey}` },
      include: { results: true },
    });
    await this.database.schedulerExecutionRecord.upsert({
      where: { idempotencyKey: execution.idempotencyKey },
      create: {
        id: execution.id,
        idempotencyKey: execution.idempotencyKey,
        trigger: execution.trigger,
        scheduledFor: execution.scheduledFor,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        durationMs: execution.durationMs,
        result: execution.result,
        ...(execution.error ? { error: execution.error } : {}),
        candidateCount: scan?.results.filter((item) => item.accepted).length ?? 0,
        rejectionCount: scan?.results.filter((item) => !item.accepted).length ?? 0,
        errorCount: scan?.symbolsFailed ?? (execution.result === 'FAILED' ? 1 : 0),
      },
      update: {},
    });
    if (execution.result === 'FAILED')
      await this.raiseAlert({
        kind: 'SCANNER_FAILED',
        severity: 'CRITICAL',
        title: 'Scheduled trading pipeline failed',
        message: execution.error ?? `Scheduler execution ${execution.id} failed`,
        component: 'scheduler',
        scope: execution.id,
      });
  }

  private async saveWorkerHeartbeat(input: {
    workerId: string;
    status: string;
    leader: boolean;
    at: Date;
    detail?: string;
  }): Promise<void> {
    await this.database.workerHeartbeatRecord.upsert({
      where: { id: input.workerId },
      create: {
        id: input.workerId,
        kind: 'TRADING_SCHEDULER',
        status: input.status,
        leader: input.leader,
        startedAt: input.at,
        heartbeatAt: input.at,
        metadata: input.detail ? { detail: input.detail } : {},
      },
      update: {
        status: input.status,
        leader: input.leader,
        heartbeatAt: input.at,
        metadata: input.detail ? { detail: input.detail } : {},
      },
    });
    if (input.status === 'FAILED')
      await this.raiseAlert({
        kind: 'SCHEDULER_STOPPED',
        severity: 'CRITICAL',
        title: 'Trading worker failed',
        message: input.detail ?? `Worker ${input.workerId} entered FAILED state`,
        component: 'scheduler-worker',
        scope: input.workerId,
      });
  }

  private async transitionOrder(orderId: string, state: OrderState, reason: string): Promise<void> {
    const order = await this.database.orderRecord.findUnique({
      where: { id: orderId },
      include: { transitions: { orderBy: { sequence: 'desc' }, take: 1 } },
    });
    if (!order || order.state === state) return;
    await this.database.$transaction(async (transaction) => {
      await transaction.orderTransitionRecord.create({
        data: {
          orderId,
          sequence: (order.transitions[0]?.sequence ?? 0) + 1,
          fromState: order.state,
          toState: state,
          reason,
          occurredAt: new Date(),
        },
      });
      await transaction.orderRecord.update({
        where: { id: orderId },
        data: { state, reconciliationDue: state === 'UNKNOWN' },
      });
      const intentState =
        state === 'FILLED'
          ? 'COMPLETED'
          : ['REJECTED', 'EXPIRED'].includes(state)
            ? 'REJECTED'
            : ['CANCELED', 'REPLACED'].includes(state)
              ? 'COMPLETED'
              : state === 'UNKNOWN'
                ? 'UNKNOWN'
                : ['PARTIALLY_FILLED', 'CANCEL_PENDING'].includes(state)
                  ? 'EXECUTING'
                  : ['SUBMITTED', 'ACCEPTED'].includes(state)
                    ? 'SUBMITTED'
                    : undefined;
      if (intentState)
        await transaction.tradeIntentRecord.update({
          where: { id: order.tradeIntentId },
          data: {
            state: intentState,
            ...(intentState === 'REJECTED' ? { rejectionReasons: [reason] } : {}),
          },
        });
    });
  }

  private async synchronizeProtectionGroups(
    brokerOrders: readonly AlpacaOrder[],
  ): Promise<string[]> {
    const unprotectedPositionIds: string[] = [];
    for (const brokerOrder of brokerOrders) {
      const localOrder = await this.database.orderRecord.findFirst({
        where: { brokerOrderId: brokerOrder.id },
      });
      if (!localOrder || !['bracket', 'oco', 'oto'].includes(localOrder.orderClass)) continue;
      const [binding, position] = await Promise.all([
        this.database.strategyPositionBindingRecord.findFirst({
          where: { symbol: brokerOrder.symbol, active: true },
        }),
        this.database.managedPositionRecord.findFirst({
          where: { symbol: brokerOrder.symbol, closedAt: null },
        }),
      ]);
      if (!binding || !position) continue;
      const legs = (Array.isArray(brokerOrder.legs) ? brokerOrder.legs : []).filter(
        (leg): leg is Record<string, unknown> => leg !== null && typeof leg === 'object',
      );
      if (legs.length === 0) {
        if (
          ['filled', 'partially_filled'].includes(brokerOrder.status) &&
          position.remainingQuantity.gt(0) &&
          position.pendingExitIntentId === null
        ) {
          await this.safety.block({
            scope: 'SYMBOL',
            scopeId: brokerOrder.symbol,
            reason: 'INVALID_CONFIGURATION',
            detail: `Mandatory broker protection missing for filled order ${brokerOrder.id}`,
            at: new Date(),
            cooldownMs: 0,
          });
          unprotectedPositionIds.push(position.id);
        }
        continue;
      }
      const group = await this.database.protectionGroupRecord.upsert({
        where: { positionBindingId: binding.id },
        create: {
          id: randomUUID(),
          symbol: brokerOrder.symbol,
          positionBindingId: binding.id,
          state: 'ACTIVE',
        },
        update: { state: 'ACTIVE' },
      });
      const currentLegIds = new Set<string>();
      for (const leg of legs) {
        const brokerOrderId = typeof leg.id === 'string' ? leg.id : undefined;
        if (!brokerOrderId) continue;
        currentLegIds.add(brokerOrderId);
        const type = (scalarString(leg.type) ?? scalarString(leg.order_type) ?? '').toLowerCase();
        const role = type.includes('stop') ? 'STOP_LOSS' : 'TAKE_PROFIT';
        const state = (scalarString(leg.status) ?? 'UNKNOWN').toUpperCase();
        const filledQuantity = scalarString(leg.filled_qty) ?? '0';
        await this.database.protectionLegRecord.upsert({
          where: { brokerOrderId },
          create: {
            id: randomUUID(),
            groupId: group.id,
            brokerOrderId,
            role,
            state,
            filledQuantity,
          },
          update: {
            groupId: group.id,
            role,
            state,
            filledQuantity,
          },
        });
      }
      if (currentLegIds.size > 0)
        await this.database.protectionLegRecord.updateMany({
          where: {
            groupId: group.id,
            brokerOrderId: { notIn: [...currentLegIds] },
            state: { notIn: ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'REPLACED'] },
          },
          data: { state: 'REPLACED' },
        });
    }
    return unprotectedPositionIds;
  }

  private async synchronizeFills(
    activities: readonly AlpacaActivity[],
    orders: readonly AlpacaOrder[],
    correlationId: string,
  ): Promise<void> {
    for (const activity of activities.filter((item) => item.activity_type === 'FILL')) {
      if (
        !activity.order_id ||
        !activity.symbol ||
        !activity.side ||
        !activity.qty ||
        !activity.price ||
        !activity.transaction_time
      )
        continue;
      const symbol = activity.symbol;
      const side = activity.side.toLowerCase();
      const occurredAt = new Date(activity.transaction_time);
      if (await this.database.fillRecord.findUnique({ where: { id: activity.id } })) continue;
      const localOrder = await this.database.orderRecord.findUnique({
        where: { brokerOrderId: activity.order_id },
        include: { intent: true },
      });
      if (!localOrder) {
        await this.safety.block({
          scope: 'GLOBAL',
          reason: 'UNEXPECTED_POSITION',
          detail: `Unexpected fill ${activity.id}`,
          at: new Date(),
          cooldownMs: 0,
        });
        await this.raiseAlert({
          kind: 'UNEXPECTED_FILL',
          severity: 'EMERGENCY',
          title: 'Unexpected broker fill',
          message: `Broker fill ${activity.id} has no matching local order`,
          component: 'reconciliation',
          scope: activity.id,
          correlationId,
          metadata: { brokerOrderId: activity.order_id, symbol },
        });
        continue;
      }
      const quantity = new Decimal(activity.qty);
      const price = new Decimal(activity.price);
      await this.database.$transaction(
        async (transaction) => {
          await transaction.fillRecord.create({
            data: {
              id: activity.id,
              orderId: localOrder.id,
              tradeIntentId: localOrder.tradeIntentId,
              symbol,
              side,
              quantity,
              price,
              occurredAt,
              unexpected: false,
            },
          });
          const filledQuantity = localOrder.filledQuantity.plus(quantity);
          const averageFillPrice = localOrder.averageFillPrice
            ? localOrder.averageFillPrice
                .mul(localOrder.filledQuantity)
                .plus(price.mul(quantity))
                .div(filledQuantity)
            : price;
          await transaction.orderRecord.update({
            where: { id: localOrder.id },
            data: { filledQuantity, averageFillPrice },
          });
          const existing = await transaction.managedPositionRecord.findFirst({
            where: { symbol, closedAt: null },
          });
          if (side === 'buy') {
            const binding = await transaction.strategyPositionBindingRecord.findFirst({
              where: { symbol, active: true },
            });
            if (!binding)
              await transaction.strategyPositionBindingRecord.create({
                data: {
                  symbol,
                  strategyId: localOrder.intent.strategyId,
                  strategyVersion: localOrder.intent.strategyVersion,
                  openedBySignalId: localOrder.intent.signalId,
                  boundAt: occurredAt,
                },
              });
            await transaction.taxLotRecord.create({
              data: {
                id: randomUUID(),
                symbol,
                acquisitionFillId: activity.id,
                acquiredAt: occurredAt,
                acquisitionPrice: price,
                originalQuantity: quantity,
                remainingQuantity: quantity,
                basisPerShare: price,
              },
            });
            if (existing) {
              const total = existing.remainingQuantity.plus(quantity);
              const average = existing.averageEntryPrice
                .mul(existing.remainingQuantity)
                .plus(price.mul(quantity))
                .div(total);
              await transaction.managedPositionRecord.update({
                where: { id: existing.id },
                data: {
                  quantity: { increment: quantity },
                  remainingQuantity: total,
                  averageEntryPrice: average,
                  highWaterPrice: Decimal.max(existing.highWaterPrice, price),
                },
              });
            } else {
              await transaction.managedPositionRecord.create({
                data: {
                  id: randomUUID(),
                  symbol,
                  strategyId: localOrder.intent.strategyId,
                  strategyVersion: localOrder.intent.strategyVersion,
                  quantity,
                  remainingQuantity: quantity,
                  averageEntryPrice: price,
                  highWaterPrice: price,
                  openedAt: occurredAt,
                },
              });
            }
          } else if (existing) {
            let remaining = quantity;
            const lots = await transaction.taxLotRecord.findMany({
              where: { symbol, remainingQuantity: { gt: 0 } },
              orderBy: { acquiredAt: 'asc' },
            });
            for (const lot of lots) {
              if (remaining.lte(0)) break;
              const disposed = Decimal.min(remaining, lot.remainingQuantity);
              await transaction.taxLotRecord.update({
                where: { id: lot.id },
                data: { remainingQuantity: lot.remainingQuantity.minus(disposed) },
              });
              await transaction.lotDispositionRecord.create({
                data: {
                  id: randomUUID(),
                  saleFillId: activity.id,
                  lotId: lot.id,
                  symbol,
                  soldAt: occurredAt,
                  quantity: disposed,
                  proceeds: price.mul(disposed),
                  costBasis: lot.basisPerShare.mul(disposed),
                  realizedPnl: price.minus(lot.basisPerShare).mul(disposed),
                },
              });
              remaining = remaining.minus(disposed);
            }
            if (remaining.gt(0))
              throw new Error(`INSUFFICIENT_TAX_LOT_QUANTITY:${symbol}:${remaining.toFixed()}`);
            const left = Decimal.max(0, existing.remainingQuantity.minus(quantity));
            await transaction.managedPositionRecord.update({
              where: { id: existing.id },
              data: {
                remainingQuantity: left,
                ...(left.isZero()
                  ? {
                      closedAt: occurredAt,
                      exitReason: 'BROKER_FILL',
                      pendingExitIntentId: null,
                    }
                  : {}),
              },
            });
            if (left.isZero())
              await transaction.strategyPositionBindingRecord.updateMany({
                where: { symbol, active: true },
                data: {
                  active: false,
                  releasedAt: occurredAt,
                },
              });
          }
        },
        { isolationLevel: 'Serializable' },
      );
      const brokerOrder = orders.find((order) => order.id === activity.order_id);
      if (brokerOrder)
        await this.transitionOrder(
          localOrder.id,
          brokerStatusToOrderState(brokerOrder.status),
          `Fill sync ${activity.id}`,
        );
      await this.recordExecutionQuality(localOrder.id, brokerOrder, occurredAt);
      await this.journal(
        localOrder.intent.correlationId,
        'FILL',
        {
          fillId: activity.id,
          orderId: localOrder.id,
          brokerOrderId: activity.order_id,
          symbol,
          side,
          quantity: activity.qty,
          price: activity.price,
        },
        localOrder.tradeIntentId,
      );
      await this.journal(
        localOrder.intent.correlationId,
        'POSITION',
        { symbol: activity.symbol, sourceFillId: activity.id },
        localOrder.tradeIntentId,
      );
      this.logger.info(
        { correlationId, fillId: activity.id, orderId: localOrder.id },
        'Broker fill synchronized',
      );
    }
  }

  private async recordExecutionQuality(
    orderId: string,
    brokerOrder: AlpacaOrder | undefined,
    filledAt: Date,
  ): Promise<void> {
    const order = await this.database.orderRecord.findUnique({
      where: { id: orderId },
      include: { intent: true, transitions: { orderBy: { sequence: 'asc' } } },
    });
    if (!order) return;
    const [signal, riskDecision] = await Promise.all([
      this.database.strategySignalRecord.findUnique({ where: { id: order.intent.signalId } }),
      this.database.riskDecisionRecord.findFirst({
        where: { signalId: order.intent.signalId },
        orderBy: { evaluatedAt: 'desc' },
      }),
    ]);
    const snapshot = asObject(riskDecision?.decisionSnapshot);
    const decisionPrice = positiveDecimal(snapshot.quotePrice) ?? order.averageFillPrice;
    if (!decisionPrice) return;
    const spreadBps = positiveDecimal(snapshot.spreadBps) ?? new Decimal(0);
    const volatility = positiveDecimal(snapshot.annualizedVolatility) ?? new Decimal(0);
    const submittedAt =
      order.transitions.find((transition) => transition.toState === 'SUBMITTED')?.occurredAt ??
      order.createdAt;
    const acceptedAt = order.transitions.find(
      (transition) => transition.toState === 'ACCEPTED',
    )?.occurredAt;
    const filledQuantity = brokerOrder ? new Decimal(brokerOrder.filled_qty) : order.filledQuantity;
    const fillPrice = brokerOrder?.filled_avg_price
      ? new Decimal(brokerOrder.filled_avg_price)
      : order.averageFillPrice;
    const measurement = measureExecutionQuality({
      id: order.id,
      symbol: order.symbol,
      strategyId: order.intent.strategyId,
      orderType: order.orderType,
      side: order.side.toLowerCase() === 'sell' ? 'sell' : 'buy',
      quantity: filledQuantity,
      requestedQuantity: order.requestedQuantity,
      decisionPrice,
      signalPrice: decisionPrice,
      submissionPrice: decisionPrice,
      arrivalPrice: decisionPrice,
      expectedFillPrice: decisionPrice,
      ...(fillPrice === null ? {} : { fillPrice }),
      spreadBps,
      volatility,
      signaledAt: signal?.signaledAt ?? order.intent.createdAt,
      submittedAt,
      ...(acceptedAt === undefined ? {} : { acceptedAt }),
      filledAt,
      rejected: brokerOrder?.status === 'rejected',
      canceled: brokerOrder?.status === 'canceled',
      partialFill: filledQuantity.lt(order.requestedQuantity),
    });
    await this.database.executionQualityRecord.upsert({
      where: { orderId: order.id },
      create: {
        id: measurement.id,
        orderId: order.id,
        symbol: order.symbol,
        strategyId: order.intent.strategyId,
        orderType: order.orderType,
        decisionPrice,
        signalPrice: decisionPrice,
        submissionPrice: decisionPrice,
        arrivalPrice: decisionPrice,
        expectedFillPrice: decisionPrice,
        ...(fillPrice === null ? {} : { fillPrice }),
        ...(measurement.absoluteSlippage === null
          ? {}
          : { absoluteSlippage: measurement.absoluteSlippage }),
        ...(measurement.slippageBps === null ? {} : { slippageBps: measurement.slippageBps }),
        ...(measurement.slippageMoney === null ? {} : { slippageMoney: measurement.slippageMoney }),
        spreadBps,
        volatility,
        quantity: filledQuantity,
        requestedQuantity: order.requestedQuantity,
        fillRatio: measurement.fillRatio,
        partialFill: filledQuantity.lt(order.requestedQuantity),
        rejected: brokerOrder?.status === 'rejected',
        canceled: brokerOrder?.status === 'canceled',
        signalToSubmitMs: measurement.signalToSubmitMs,
        ...(measurement.submitToAcceptedMs === null
          ? {}
          : { submitToAcceptedMs: measurement.submitToAcceptedMs }),
        ...(measurement.acceptedToFillMs === null
          ? {}
          : { acceptedToFillMs: measurement.acceptedToFillMs }),
        observedAt: filledAt,
      },
      update: {
        fillPrice,
        absoluteSlippage: measurement.absoluteSlippage,
        slippageBps: measurement.slippageBps,
        slippageMoney: measurement.slippageMoney,
        quantity: filledQuantity,
        fillRatio: measurement.fillRatio,
        partialFill: filledQuantity.lt(order.requestedQuantity),
        acceptedToFillMs: measurement.acceptedToFillMs,
        observedAt: filledAt,
      },
    });
  }

  private async persistPortfolio(
    account: AlpacaAccount,
    positions: Awaited<ReturnType<AlpacaTradingClient['listPositions']>>,
    orders: readonly AlpacaOrder[],
  ): Promise<void> {
    const expected = new Set(
      (await this.database.managedPositionRecord.findMany({ where: { closedAt: null } })).map(
        (position) => position.symbol,
      ),
    );
    const realized = await this.database.lotDispositionRecord.aggregate({
      _sum: { realizedPnl: true },
    });
    const state = buildPortfolioState({
      account,
      positions,
      orders,
      latestPrices: Object.fromEntries(
        positions.map((position) => [position.symbol, position.current_price]),
      ),
      realizedPnl: realized._sum.realizedPnl?.toFixed() ?? '0',
      expectedPositionSymbols: expected,
      capturedAt: new Date(),
    });
    await this.database.portfolioSnapshot.create({
      data: {
        equity: state.equity,
        cash: state.cash,
        buyingPower: state.buyingPower,
        portfolioValue: state.portfolioValue,
        accountStatus: account.status,
        daytradeCount: account.daytrade_count,
        currency: account.currency,
        brokerTime: state.capturedAt,
        positions: {
          create: state.positions.map((position) => ({
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
            averageEntryPrice: position.averageEntryPrice,
            marketPrice: position.marketPrice,
            marketValue: position.marketValue,
            costBasis: position.costBasis,
            unrealizedPnl: position.unrealizedPnl,
            realizedPnl: 0,
            pendingOrderExposure:
              state.exposures.find((item) => item.symbol === position.symbol)
                ?.pendingOrderNotional ?? 0,
            unexpected: state.unexpectedPositions.includes(position.symbol),
            orphaned: false,
          })),
        },
      },
    });
    const previous = await this.database.equityCurvePointRecord.findFirst({
      orderBy: { capturedAt: 'desc' },
    });
    const high = Decimal.max(previous?.highWaterMark ?? state.equity, state.equity);
    const drawdown = high.minus(state.equity);
    await this.database.equityCurvePointRecord.create({
      data: {
        equity: state.equity,
        highWaterMark: high,
        drawdown,
        drawdownPercent: high.isZero() ? 0 : drawdown.div(high).mul(100),
        unrealizedPnl: state.positions.reduce(
          (sum, position) => sum.plus(position.unrealizedPnl),
          new Decimal(0),
        ),
        realizedPnl: state.realizedPnl,
        capturedAt: state.capturedAt,
      },
    });
  }

  private async runBacktestJob(
    jobId: string,
    symbol: string,
    strategy: StrategyDefinition,
    from: Date,
    to: Date,
    initialCapital: number,
  ): Promise<void> {
    const startedAt = new Date();
    const claimed = await this.database.backtestJobRecord.updateMany({
      where: { id: jobId, status: 'QUEUED', cancelAt: null },
      data: { status: 'RUNNING', startedAt, progress: 1 },
    });
    if (claimed.count !== 1) return;
    let datasetHash = '';
    try {
      await this.calendar.refresh(
        new Date(from.getTime() - 14 * 86_400_000).toISOString().slice(0, 10),
        to.toISOString().slice(0, 10),
      );
      const engine = new BacktestEngine({
        loadHistoricalBars: async (requestedSymbol, requestedFrom, requestedTo) => {
          const bars = await this.marketData.getHistoricalBars({
            symbols: [requestedSymbol],
            timeframe: strategy.timeframe,
            start: requestedFrom,
            end: requestedTo,
            adjusted: true,
          });
          if (bars.length > 500_000) throw new Error('BACKTEST_BAR_LIMIT_EXCEEDED');
          datasetHash = sha256(
            bars
              .map(
                (bar) =>
                  `${bar.symbol}|${bar.timestamp.toISOString()}|${bar.open}|${bar.high}|${bar.low}|${bar.close}|${bar.volume}`,
              )
              .join('\n'),
          );
          return bars;
        },
        buildStrategyContext: (bars, _strategy, hasPosition) =>
          this.buildBacktestContext(bars, hasPosition, strategy.timeframe),
        calculateQuantity: ({ cash, entryPrice, stopPrice }) => {
          const stopDistance = entryPrice.minus(stopPrice).abs();
          if (!stopDistance.gt(0)) return new Decimal(0);
          return Decimal.min(
            cash.mul(0.005).div(stopDistance),
            cash.div(entryPrice),
          ).toDecimalPlaces(6, Decimal.ROUND_DOWN);
        },
        riskAllowsEntry: ({ cash, price, quantity }) =>
          quantity.gt(0) && price.mul(quantity).lte(cash),
        isSessionBar: (bar) =>
          this.calendar.isExpectedBarTime(bar.timestamp, strategy.timeframe, true),
        onProgress: async (progress) => {
          await this.database.backtestJobRecord.updateMany({
            where: { id: jobId, cancelAt: null },
            data: { progress: Math.min(99, Math.max(1, progress)) },
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
        shouldCancel: async () => {
          const record = await this.database.backtestJobRecord.findUnique({
            where: { id: jobId },
            select: { cancelAt: true },
          });
          return record?.cancelAt != null;
        },
        persist: (result) => this.persistBacktestResult(result),
      });
      const result = await engine.run(
        {
          id: jobId,
          symbol,
          from,
          to,
          initialCapital,
          warmupBars: Math.max(this.config.runtime.marketDataWarmupBars, 60),
          stopLossPercent: 2,
          takeProfitPercent: 4,
          slippageBps: 3,
          halfSpreadBps: 2,
          marketImpactBps: 2,
          maximumParticipationRate: 0.01,
          commissionPerShare: 0.005,
          annualizationPeriods: 252 * 390,
        },
        strategy,
      );
      await this.database.backtestJobRecord.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          datasetHash,
          runId: result.id,
          finishedAt: new Date(),
        },
      });
    } catch (error) {
      const currentJob = await this.database.backtestJobRecord.findUnique({
        where: { id: jobId },
        select: { cancelAt: true },
      });
      const canceled =
        (error instanceof Error && error.message === 'BACKTEST_CANCELED') ||
        currentJob?.cancelAt != null;
      await this.database.backtestJobRecord.update({
        where: { id: jobId },
        data: {
          status: canceled ? 'CANCELED' : 'FAILED',
          error: error instanceof Error ? error.message : 'Unknown backtest error',
          finishedAt: new Date(),
        },
      });
    }
  }

  private buildBacktestContext(
    bars: readonly MarketBar[],
    hasOpenPosition: boolean,
    timeframe: StrategyDefinition['timeframe'],
  ): StrategyContext {
    const lastBar = bars.at(-1);
    if (!lastBar) throw new Error('BACKTEST_CONTEXT_REQUIRES_BARS');
    const closes = bars.map((bar) => bar.close);
    const bands = bollingerBands(closes, 20, 2);
    const volumeAverage = averageVolume(bars.slice(0, -1), 20);
    const previous = bars.slice(-21, -1);
    const average = latest(volumeAverage, (value) => value);
    return {
      symbol: lastBar.symbol,
      timestamp: lastBar.timestamp,
      timeframe,
      price: lastBar.close,
      indicators: {
        'ema.fast': latest(ema(closes, 20), (value) => value),
        'ema.slow': latest(ema(closes, 50), (value) => value),
        adx: latest(adx(bars, 14).adx, (value) => value),
        rsi: latest(rsi(closes, 14), (value) => value),
        'bollinger.lower': latest(bands.lower, (value) => value),
        'bollinger.middle': latest(bands.middle, (value) => value),
        atr: latest(atr(bars, 14), (value) => value),
        'average.volume': average,
        'volume.ratio': average && average > 0 ? lastBar.volume / average : null,
        'rolling.high': previous.length ? Math.max(...previous.map((bar) => bar.high)) : null,
        volatility: latest(rollingVolatility(closes, 20, 252 * 390), (value) => value),
      },
      hasOpenPosition,
      eventRisk: 'NONE',
    };
  }

  private async persistBacktestResult(result: BacktestResult): Promise<void> {
    const sampled = sampleEquityCurve(result.equityCurve, 2_000);
    await this.database.backtestRunRecord.create({
      data: {
        id: result.id,
        configurationId: result.configuration.id,
        symbol: result.configuration.symbol,
        strategyId: result.strategyId,
        strategyVersion: result.strategyVersion,
        configurationVersion: result.configurationVersion,
        inputConfiguration: toJsonValue(result.configuration),
        metrics: toJsonValue(result.metrics),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        trades: {
          create: result.trades.map((trade) => ({
            id: trade.id,
            symbol: trade.symbol,
            strategyId: trade.strategyId,
            strategyVersion: trade.strategyVersion,
            configurationVersion: trade.configurationVersion,
            entrySignalAt: trade.entrySignalAt,
            enteredAt: trade.enteredAt,
            entryPrice: trade.entryPrice,
            quantity: trade.quantity,
            exitedAt: trade.exitedAt,
            exitPrice: trade.exitPrice,
            exitReason: trade.exitReason,
            commission: trade.commission,
            pnl: trade.pnl,
            holdingMs: BigInt(Math.round(trade.holdingMs)),
          })),
        },
        equityCurve: {
          create: sampled.map((point) => ({
            timestamp: point.timestamp,
            equity: point.equity,
            drawdownPercent: point.drawdownPercent,
          })),
        },
      },
    });
  }

  private async entryReadinessChecks(): Promise<Record<string, boolean>> {
    if (!this.config.trading.brokerConnectivityEnabled) return { broker: false };
    const [account, clock, reconciliation, unknownOrders, marketStates, heartbeat, schedulerState] =
      await Promise.all([
        this.readTrading.getAccount().catch(() => undefined),
        this.database.marketClockRecord.findUnique({ where: { id: 'singleton' } }),
        this.database.reconciliationRecord.findFirst({ orderBy: { startedAt: 'desc' } }),
        this.database.orderRecord.count({ where: { state: 'UNKNOWN' } }),
        this.database.marketDataStateRecord.findMany(),
        this.database.workerHeartbeatRecord.findUnique({ where: { id: this.instanceId } }),
        this.database.schedulerStateRecord.findUnique({ where: { id: 'singleton' } }),
      ]);
    return {
      broker: !!account && accountTradeable(account),
      clock: !!clock && Date.now() - clock.observedAt.getTime() < 120_000,
      reconciliation:
        !!reconciliation?.finishedAt &&
        ['MATCHED', 'CORRECTED'].includes(reconciliation.state) &&
        Date.now() - reconciliation.finishedAt.getTime() <
          this.config.runtime.reconciliationIntervalMs * 2,
      unknownOrders: unknownOrders === 0,
      marketData:
        this.marketStream.state() === 'SUBSCRIBED' &&
        marketStates.length > 0 &&
        marketStates.every((state) => state.health === 'HEALTHY'),
      worker:
        !!heartbeat &&
        !['FAILED', 'STOPPED'].includes(heartbeat.status) &&
        schedulerState?.state === 'RUNNING' &&
        Date.now() - heartbeat.heartbeatAt.getTime() < this.config.runtime.workerDeadAfterMs,
      risk: await this.activeRisk()
        .then(() => true)
        .catch(() => false),
      circuits: (await this.persistentCircuits.listOpen()).length === 0,
    };
  }

  private async journal(
    correlationId: string,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    tradeId?: string,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${correlationId}))`;
      const previous = await transaction.tradingJournalRecord.findFirst({
        where: { correlationId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      await transaction.tradingJournalRecord.create({
        data: {
          id: randomUUID(),
          correlationId,
          ...(tradeId === undefined ? {} : { tradeId }),
          type,
          sequence: (previous?.sequence ?? 0) + 1,
          payload: toJsonValue(payload),
          occurredAt: new Date(),
        },
      });
    });
  }

  private async riskLimitsHealthy(): Promise<boolean> {
    const now = new Date();
    const [risk, portfolio, equity, dailyPnl] = await Promise.all([
      this.activeRisk(),
      this.database.portfolioSnapshot.findFirst({ orderBy: { createdAt: 'desc' } }),
      this.database.equityCurvePointRecord.findFirst({ orderBy: { capturedAt: 'desc' } }),
      this.database.lotDispositionRecord.aggregate({
        where: { soldAt: { gte: startOfMarketDay(now) } },
        _sum: { realizedPnl: true },
      }),
    ]);
    if (!portfolio || !equity) return false;
    const realized = dailyPnl._sum.realizedPnl ?? new Decimal(0);
    const percentageLimit = portfolio.equity
      .mul(risk.configuration.dailyLossLimitPercent)
      .div(100)
      .negated();
    return (
      realized.gte(percentageLimit) &&
      realized.gte(new Decimal(risk.configuration.dailyLossLimitAmount).negated()) &&
      equity.drawdownPercent.lte(risk.configuration.maximumDrawdownPercent)
    );
  }

  private async reassessOperationalReadiness(): Promise<void> {
    const checks = await this.refreshCalendarAndClock()
      .then(() => this.entryReadinessChecks())
      .catch(() => ({ broker: false, clock: false }));
    const failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failed.length === 0) return;
    const now = new Date();
    if (this.safety.snapshot().entriesEnabled)
      await this.safety.disableEntries(
        'readiness-monitor',
        `Failed checks: ${failed.join(',')}`,
        now,
      );
    const reason = failed.includes('broker')
      ? 'BROKER_DISCONNECTED'
      : failed.includes('marketData')
        ? 'INVALID_MARKET_DATA'
        : failed.includes('reconciliation')
          ? 'RECONCILIATION_FAILED'
          : failed.includes('unknownOrders')
            ? 'UNKNOWN_ORDER'
            : 'INVALID_CONFIGURATION';
    await this.safety.block({
      scope: 'GLOBAL',
      reason,
      detail: `Continuous readiness failed: ${failed.join(', ')}`,
      at: now,
      cooldownMs: 60_000,
    });
    if (this.operationalState.current().state !== 'BLOCKED')
      await this.operationalState.transition(
        'BLOCKED',
        `READINESS_REVOKED_${failed.join('_').toUpperCase()}`,
        'readiness-monitor',
      );
    await this.database.liveReadinessRecord.updateMany({
      where: { state: 'ACTIVE' },
      data: { state: 'REVOKED', revokedAt: now },
    });
    const alertKind: AlertKind = failed.includes('broker')
      ? 'ALPACA_DISCONNECTED'
      : failed.includes('marketData')
        ? 'MARKET_DATA_STALE'
        : failed.includes('worker')
          ? 'SCHEDULER_STOPPED'
          : failed.includes('reconciliation')
            ? 'RECONCILIATION_MISMATCH'
            : failed.includes('unknownOrders')
              ? 'ORDER_UNKNOWN'
              : 'SYSTEM_BLOCKED';
    await this.raiseAlert({
      kind: alertKind,
      severity: 'CRITICAL',
      title: 'Continuous readiness revoked',
      message: `Failed checks: ${failed.join(', ')}`,
      component: 'readiness-monitor',
      scope: failed.sort().join(','),
      metadata: { failedChecks: failed },
    });
  }

  private async raiseAlert(input: {
    readonly kind: AlertKind;
    readonly severity: AlertSeverity;
    readonly title: string;
    readonly message: string;
    readonly component: string;
    readonly scope: string;
    readonly correlationId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    await this.alerts
      .raise({
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        message: input.message,
        component: input.component,
        deduplicationScope: input.scope,
        occurredAt: new Date(),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      })
      .then(() => undefined)
      .catch((error: unknown) =>
        this.logger.error(
          { err: error, alertKind: input.kind, component: input.component },
          'Alert persistence or delivery failed',
        ),
      );
  }
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function positiveDecimal(value: unknown): Decimal | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() && decimal.gte(0) ? decimal : undefined;
  } catch {
    return undefined;
  }
}

const CORPORATE_ACTION_TYPES: Readonly<Record<string, CorporateActionType>> = {
  forward_splits: 'FORWARD_SPLIT',
  reverse_splits: 'REVERSE_SPLIT',
  cash_dividends: 'CASH_DIVIDEND',
  stock_dividends: 'STOCK_DIVIDEND',
  name_changes: 'NAME_CHANGE',
  symbol_changes: 'SYMBOL_CHANGE',
  cash_mergers: 'CASH_MERGER',
  stock_mergers: 'STOCK_MERGER',
  stock_and_cash_mergers: 'STOCK_AND_CASH_MERGER',
  spin_offs: 'SPIN_OFF',
  redemptions: 'REDEMPTION',
  delistings: 'DELISTING',
  worthless_removals: 'WORTHLESS_REMOVAL',
  reorganizations: 'REORGANIZATION',
  partial_calls: 'PARTIAL_CALL',
};

function corporateActionFromWire(
  category: string,
  raw: Readonly<Record<string, unknown>>,
): CorporateAction | undefined {
  const type = CORPORATE_ACTION_TYPES[category.toLowerCase()];
  const string = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return undefined;
  };
  const symbol = string('symbol', 'old_symbol');
  const effective = string(
    'process_date',
    'ex_date',
    'payable_date',
    'record_date',
    'effective_date',
  );
  if (!type || !symbol || !effective) return undefined;
  const effectiveAt = new Date(effective.includes('T') ? effective : `${effective}T00:00:00.000Z`);
  if (!Number.isFinite(effectiveAt.getTime())) return undefined;
  const id =
    string('id', 'corporate_action_id', 'ca_id') ?? sha256(`${category}:${JSON.stringify(raw)}`);
  const quantityRatio = string('new_rate', 'rate', 'ratio');
  const cashAmount = string('cash', 'cash_amount', 'amount');
  const newSymbol = string('new_symbol');
  return {
    id,
    type,
    status: 'PENDING',
    symbol: symbol.toUpperCase(),
    ...(newSymbol ? { newSymbol: newSymbol.toUpperCase() } : {}),
    effectiveAt,
    ...(quantityRatio ? { quantityRatio } : {}),
    ...(cashAmount ? { cashAmount } : {}),
    raw,
  };
}

function sampleEquityCurve(
  curve: BacktestResult['equityCurve'],
  maximumPoints: number,
): BacktestResult['equityCurve'] {
  if (curve.length <= maximumPoints) return curve;
  const step = Math.ceil(curve.length / maximumPoints);
  const sampled = curve.filter((_point, index) => index % step === 0);
  const last = curve.at(-1);
  if (last && sampled.at(-1)?.timestamp.getTime() !== last.timestamp.getTime()) sampled.push(last);
  return sampled;
}
