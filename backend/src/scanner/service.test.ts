import { describe, expect, it, vi } from 'vitest';
import { StrategyEngine } from '../strategies/engine.js';
import { createTrendStrategy } from '../strategies/implementations.js';
import type { StrategyContext } from '../strategies/types.js';
import { ScannerService, type ScannerExecution } from './service.js';

describe('ScannerService', () => {
  it('continues after a symbol error, ranks results, and is idempotent', async () => {
    const engine = new StrategyEngine({ configurationSnapshot: {}, idFactory: () => 'signal-id' });
    const strategy = createTrendStrategy({
      version: '1',
      configurationVersion: '1',
      deploymentId: 'd1',
    });
    engine.register(strategy);
    const completed = new Map<string, ScannerExecution>();
    const saveExecution = vi.fn(async (execution: ScannerExecution) => {
      completed.set(execution.idempotencyKey, execution);
    });
    const scanner = new ScannerService(
      engine,
      {
        findExecutionByIdempotencyKey: async (key) => completed.get(key),
        executeWithLock: async (_executionId, operation) => operation(),
        loadWatchlist: async () => ['BAD', 'AAPL'],
        loadMarketData: async (symbol) => {
          if (symbol === 'BAD') throw new Error('feed unavailable');
          return { price: 100 };
        },
        validateMarketData: () => [],
        buildContext: (symbol, data, now): StrategyContext => ({
          symbol,
          timestamp: now,
          timeframe: '1Min',
          price: data.price,
          indicators: { 'ema.fast': 102, 'ema.slow': 100, adx: 30 },
          hasOpenPosition: false,
          eventRisk: 'NONE',
        }),
        selectStrategies: () => [strategy],
        preRankingFilter: () => undefined,
        postRankingFilter: () => undefined,
        score: (signal) => signal.confidence ?? 0,
        routeCandidate: async () => undefined,
        saveExecution,
      },
      () => 'scan-id',
    );
    const input = {
      idempotencyKey: 'scheduled:2026-08-18T14:00',
      trigger: 'SCHEDULED' as const,
      now: new Date('2026-08-18T14:00:00.000Z'),
    };
    const first = await scanner.execute(input);
    const second = await scanner.execute(input);
    expect(first).toBe(second);
    expect(first.status).toBe('PARTIAL');
    expect(first.candidates).toHaveLength(1);
    expect(first.rejections).toContainEqual(
      expect.objectContaining({ symbol: 'BAD', code: 'SYMBOL_PROCESSING_ERROR' }),
    );
    expect(saveExecution).toHaveBeenCalledOnce();
  });
});
