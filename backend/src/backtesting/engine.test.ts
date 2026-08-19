import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { BacktestEngine, compareBacktests } from './engine.js';
import type { StrategyDefinition } from '../strategies/types.js';

const strategy: StrategyDefinition = {
  id: 'shared-strategy',
  version: '2.1.0',
  configurationVersion: 'config-7',
  deploymentId: 'backtest',
  lifecycle: 'ACTIVE',
  timeframe: '1Min',
  sessionPolicy: 'REGULAR_ONLY',
  overnightPolicy: 'FLAT_AT_CLOSE',
  eventRiskPolicy: 'BLOCK_ENTRIES',
  parameters: {},
  requiredIndicators: [],
  cooldownMs: 0,
  maximumSignalsPerDay: 10,
  maximumTradesPerDay: 1,
  evaluate: (context) => ({
    type: context.hasOpenPosition ? 'HOLD' : 'BUY',
    reason: 'deterministic test entry',
    expiresAt: new Date(context.timestamp.getTime() + 60_000),
  }),
};

describe('BacktestEngine', () => {
  it('uses only visible bars, fills on the next open, and simulates a conservative stop', async () => {
    const bars = [
      { timestamp: '2026-01-02T14:29:00Z', open: 99, high: 100, low: 98, close: 99 },
      { timestamp: '2026-01-02T14:30:00Z', open: 100, high: 101, low: 99, close: 100 },
      { timestamp: '2026-01-02T14:31:00Z', open: 101, high: 102, low: 96, close: 97 },
      { timestamp: '2026-01-02T14:32:00Z', open: 97, high: 101, low: 96, close: 100 },
    ].map((bar) => ({
      symbol: 'AAPL',
      timestamp: new Date(bar.timestamp),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: 100_000,
    }));
    const visibleLengths: number[] = [];
    const persist = vi.fn(async () => undefined);
    let id = 0;
    const engine = new BacktestEngine({
      loadHistoricalBars: async () => bars,
      buildStrategyContext: (visible, _strategy, hasPosition) => {
        visibleLengths.push(visible.length);
        const latest = visible.at(-1);
        if (latest === undefined) throw new Error('missing latest bar');
        return {
          symbol: latest.symbol,
          timestamp: latest.timestamp,
          timeframe: '1Min',
          price: latest.close,
          indicators: {},
          hasOpenPosition: hasPosition,
          eventRisk: 'NONE',
        };
      },
      calculateQuantity: () => new Decimal(10),
      riskAllowsEntry: () => true,
      persist,
      now: () => new Date('2026-01-03T00:00:00Z'),
      idFactory: () => `id-${(id += 1)}`,
    });
    const result = await engine.run(
      {
        id: 'backtest',
        symbol: 'AAPL',
        from: new Date('2026-01-02T14:30:00Z'),
        to: new Date('2026-01-02T14:33:00Z'),
        initialCapital: 10_000,
        warmupBars: 1,
        stopLossPercent: 2,
        takeProfitPercent: 5,
        slippageBps: 10,
        commissionPerShare: 0.01,
        annualizationPeriods: 252,
      },
      strategy,
    );
    expect(visibleLengths).toEqual([2, 3, 4]);
    expect(result.trades[0]).toMatchObject({ exitReason: 'STOP' });
    expect(result.trades[0]?.entryPrice.toNumber()).toBeCloseTo(101.101);
    expect(result.metrics.netProfit.lt(0)).toBe(true);
    expect(result.metrics).toMatchObject({ tradeCount: 1, sampleSufficient: false });
    expect(persist).toHaveBeenCalledWith(result);
    expect(compareBacktests([result])).toEqual([result]);
  });

  it('closes FLAT_AT_CLOSE positions on the prior session close and never carries an entry signal overnight', async () => {
    const bars = [
      ['2026-01-02T14:29:00Z', 99, 99, 99, 99],
      ['2026-01-02T14:30:00Z', 100, 100, 100, 100],
      ['2026-01-02T14:31:00Z', 101, 101, 101, 101],
      ['2026-01-05T14:30:00Z', 110, 110, 110, 110],
      ['2026-01-05T14:31:00Z', 111, 111, 111, 111],
    ].map(([timestamp, open, high, low, close]) => ({
      symbol: 'AAPL',
      timestamp: new Date(String(timestamp)),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: 100_000,
    }));
    let id = 0;
    const engine = new BacktestEngine({
      loadHistoricalBars: async () => bars,
      buildStrategyContext: (visible, _definition, hasPosition) => {
        const latest = visible.at(-1);
        if (latest === undefined) throw new Error('missing latest bar');
        return {
          symbol: 'AAPL',
          timestamp: latest.timestamp,
          timeframe: '1Min',
          price: latest.close,
          indicators: {},
          hasOpenPosition: hasPosition,
          eventRisk: 'NONE',
        };
      },
      calculateQuantity: () => new Decimal(1),
      riskAllowsEntry: () => true,
      persist: async () => undefined,
      now: () => new Date('2026-01-06T00:00:00Z'),
      idFactory: () => `session-${(id += 1)}`,
    });
    const result = await engine.run(
      {
        id: 'session-close',
        symbol: 'AAPL',
        from: new Date('2026-01-02T14:30:00Z'),
        to: new Date('2026-01-05T14:32:00Z'),
        initialCapital: 10_000,
        warmupBars: 1,
        stopLossPercent: 20,
        takeProfitPercent: 20,
        slippageBps: 0,
        commissionPerShare: 0,
        annualizationPeriods: 252,
      },
      strategy,
    );
    expect(result.trades[0]).toMatchObject({
      exitReason: 'SESSION_CLOSE',
      exitPrice: new Decimal(101),
      exitedAt: new Date('2026-01-02T14:32:00Z'),
    });
    expect(result.trades[0]?.exitPrice.toNumber()).not.toBe(110);
  });

  it('uses the conservative stop when stop and target are both touched in one bar', async () => {
    const bars = [
      { timestamp: '2026-01-02T14:29:00Z', open: 100, high: 100, low: 100, close: 100 },
      { timestamp: '2026-01-02T14:30:00Z', open: 100, high: 100, low: 100, close: 100 },
      { timestamp: '2026-01-02T14:31:00Z', open: 100, high: 103, low: 97, close: 101 },
    ].map((value) => ({
      ...value,
      symbol: 'AAPL',
      timestamp: new Date(value.timestamp),
      volume: 100_000,
    }));
    let id = 0;
    const engine = new BacktestEngine({
      loadHistoricalBars: async () => bars,
      buildStrategyContext: (visible, _definition, hasPosition) => {
        const latest = visible.at(-1);
        if (latest === undefined) throw new Error('missing latest bar');
        return {
          symbol: 'AAPL',
          timestamp: latest.timestamp,
          timeframe: '1Min',
          price: latest.close,
          indicators: {},
          hasOpenPosition: hasPosition,
          eventRisk: 'NONE',
        };
      },
      calculateQuantity: () => new Decimal(1),
      riskAllowsEntry: () => true,
      persist: async () => undefined,
      idFactory: () => `ambiguity-${(id += 1)}`,
    });
    const result = await engine.run(
      {
        id: 'intrabar-ambiguity',
        symbol: 'AAPL',
        from: new Date('2026-01-02T14:30:00Z'),
        to: new Date('2026-01-02T14:32:00Z'),
        initialCapital: 10_000,
        warmupBars: 1,
        stopLossPercent: 2,
        takeProfitPercent: 2,
        slippageBps: 0,
        commissionPerShare: 0,
        annualizationPeriods: 252,
      },
      strategy,
    );
    expect(result.trades[0]).toMatchObject({ exitReason: 'STOP' });
  });
});
