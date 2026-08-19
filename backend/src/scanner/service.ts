import { randomUUID } from 'node:crypto';
import type { StrategyEngine } from '../strategies/engine.js';
import type { StrategyContext, StrategyDefinition, StrategySignal } from '../strategies/types.js';

export type ScannerTrigger = 'MANUAL' | 'SCHEDULED';
export type ScannerExecutionStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface ScanCandidate {
  readonly rank: number;
  readonly score: number;
  readonly signal: StrategySignal;
}

export interface ScanRejection {
  readonly symbol: string;
  readonly strategyId?: string;
  readonly code: string;
  readonly reason: string;
}

export interface ScannerExecution {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly trigger: ScannerTrigger;
  readonly status: ScannerExecutionStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly candidates: readonly ScanCandidate[];
  readonly rejections: readonly ScanRejection[];
  readonly symbolsProcessed: number;
  readonly symbolsFailed: number;
}

export interface ScannerDependencies<TMarketData> {
  findExecutionByIdempotencyKey(key: string): Promise<ScannerExecution | undefined>;
  executeWithLock<T>(executionId: string, operation: () => Promise<T>): Promise<T>;
  loadWatchlist(): Promise<readonly string[]>;
  loadMarketData(symbol: string): Promise<TMarketData>;
  validateMarketData(symbol: string, data: TMarketData): readonly string[];
  buildContext(symbol: string, data: TMarketData, now: Date): StrategyContext;
  selectStrategies(context: StrategyContext): readonly StrategyDefinition[];
  preRankingFilter(signal: StrategySignal): string | undefined;
  postRankingFilter(candidate: ScanCandidate): string | undefined;
  score(signal: StrategySignal): number;
  routeCandidate(candidate: ScanCandidate, executionId: string): Promise<ScanRejection | undefined>;
  saveExecution(execution: ScannerExecution): Promise<void>;
}

export class ScannerService<TMarketData> {
  public constructor(
    private readonly engine: StrategyEngine,
    private readonly dependencies: ScannerDependencies<TMarketData>,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  public async execute(input: {
    idempotencyKey: string;
    trigger: ScannerTrigger;
    now: Date;
    maximumSymbols?: number;
    maximumDurationMs?: number;
  }): Promise<ScannerExecution> {
    const prior = await this.dependencies.findExecutionByIdempotencyKey(input.idempotencyKey);
    if (prior !== undefined) return prior;
    const id = this.idFactory();
    return this.dependencies.executeWithLock(id, async () => {
      const existing = await this.dependencies.findExecutionByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) return existing;
      const startedAt = new Date(input.now);
      const deadlineStartedAt = Date.now();
      const candidates: ScanCandidate[] = [];
      const rejections: ScanRejection[] = [];
      let symbolsProcessed = 0;
      let symbolsFailed = 0;
      const maximumSymbols = Math.max(1, input.maximumSymbols ?? 500);
      const maximumDurationMs = Math.max(1_000, input.maximumDurationMs ?? 120_000);
      const watchlist = [...new Set(await this.dependencies.loadWatchlist())].sort();
      const symbols = watchlist.slice(0, maximumSymbols);
      if (watchlist.length > symbols.length)
        rejections.push({
          symbol: '*',
          code: 'SYMBOL_LIMIT_REACHED',
          reason: `Run limited to ${maximumSymbols} of ${watchlist.length} symbols`,
        });
      for (const symbol of symbols) {
        if (Date.now() - deadlineStartedAt > maximumDurationMs) {
          rejections.push({
            symbol: '*',
            code: 'RUN_DEADLINE_EXCEEDED',
            reason: `Scanner exceeded ${maximumDurationMs} ms deadline`,
          });
          symbolsFailed += symbols.length - symbolsProcessed;
          break;
        }
        try {
          const marketData = await this.dependencies.loadMarketData(symbol);
          const validation = this.dependencies.validateMarketData(symbol, marketData);
          if (validation.length > 0) {
            rejections.push(
              ...validation.map((reason) => ({
                symbol,
                code: 'INVALID_MARKET_DATA',
                reason,
              })),
            );
            symbolsProcessed += 1;
            continue;
          }
          const context = this.dependencies.buildContext(symbol, marketData, input.now);
          for (const strategy of this.dependencies.selectStrategies(context)) {
            const result = await this.engine.evaluate(strategy, context);
            if (result.rejection !== undefined) {
              rejections.push({
                symbol,
                strategyId: strategy.id,
                code: result.rejection.code,
                reason: result.rejection.detail,
              });
              continue;
            }
            if (result.signal === undefined || result.signal.type === 'HOLD') continue;
            const preRankingReason = this.dependencies.preRankingFilter(result.signal);
            if (preRankingReason !== undefined) {
              rejections.push({
                symbol,
                strategyId: strategy.id,
                code: 'PRE_RANKING_FILTER',
                reason: preRankingReason,
              });
              continue;
            }
            candidates.push({
              rank: 0,
              score: this.dependencies.score(result.signal),
              signal: result.signal,
            });
          }
          symbolsProcessed += 1;
        } catch (error) {
          symbolsFailed += 1;
          rejections.push({
            symbol,
            code: 'SYMBOL_PROCESSING_ERROR',
            reason: error instanceof Error ? error.message : 'Unknown symbol error',
          });
        }
      }
      const ranked = candidates
        .sort(
          (left, right) =>
            right.score - left.score || left.signal.symbol.localeCompare(right.signal.symbol),
        )
        .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
      const accepted: ScanCandidate[] = [];
      for (const candidate of ranked) {
        const postRankingReason = this.dependencies.postRankingFilter(candidate);
        if (postRankingReason === undefined) {
          const pipelineRejection = await this.dependencies.routeCandidate(candidate, id);
          if (pipelineRejection === undefined) accepted.push(candidate);
          else rejections.push(pipelineRejection);
        } else
          rejections.push({
            symbol: candidate.signal.symbol,
            strategyId: candidate.signal.strategyId,
            code: 'POST_RANKING_FILTER',
            reason: postRankingReason,
          });
      }
      const finishedAt = new Date();
      const execution: ScannerExecution = {
        id,
        idempotencyKey: input.idempotencyKey,
        trigger: input.trigger,
        status: symbolsFailed === 0 ? 'COMPLETED' : accepted.length > 0 ? 'PARTIAL' : 'FAILED',
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        candidates: accepted,
        rejections,
        symbolsProcessed,
        symbolsFailed,
      };
      await this.dependencies.saveExecution(execution);
      return execution;
    });
  }
}
