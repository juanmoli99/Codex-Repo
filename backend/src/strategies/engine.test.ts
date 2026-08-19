import { describe, expect, it, vi } from 'vitest';
import { StrategyEngine, selectStrategyForRegime } from './engine.js';
import {
  createBreakoutStrategy,
  createMeanReversionStrategy,
  createTrendStrategy,
} from './implementations.js';
import type { StrategyContext } from './types.js';

const metadata = {
  version: '1.0.0',
  configurationVersion: 'risk-v1',
  deploymentId: 'deployment-1',
} as const;

function context(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    symbol: 'AAPL',
    timestamp: new Date('2026-08-18T14:00:00.000Z'),
    timeframe: '1Min',
    price: 100,
    indicators: { 'ema.fast': 102, 'ema.slow': 100, adx: 30, volatility: 0.3 },
    hasOpenPosition: false,
    eventRisk: 'NONE',
    ...overrides,
  };
}

describe('StrategyEngine', () => {
  it('emits immutable versioned signals and rejects duplicates', async () => {
    const saveSignal = vi.fn(async () => undefined);
    const engine = new StrategyEngine({
      configurationSnapshot: { risk: 'paper-v1' },
      persistence: { saveSignal, saveMigration: vi.fn(async () => undefined) },
      idFactory: () => 'signal-1',
    });
    const strategy = createTrendStrategy(metadata);
    engine.register(strategy);

    const first = await engine.evaluate(strategy, context());
    expect(first.signal).toMatchObject({
      id: 'signal-1',
      type: 'BUY',
      strategyVersion: '1.0.0',
      configurationVersion: 'risk-v1',
      deploymentId: 'deployment-1',
    });
    expect(Object.isFrozen(first.signal?.configurationSnapshot)).toBe(true);
    expect((await engine.evaluate(strategy, context())).rejection?.code).toBe('DUPLICATE_SIGNAL');
    expect(saveSignal).toHaveBeenCalledOnce();
  });

  it('allows a retiring version to manage only its original positions', async () => {
    const engine = new StrategyEngine({ configurationSnapshot: {} });
    const retiring = createTrendStrategy({ ...metadata, lifecycle: 'RETIRING' });
    engine.register(retiring);
    expect((await engine.evaluate(retiring, context())).rejection?.code).toBe(
      'STRATEGY_NOT_ACTIVE',
    );
    const managed = await engine.evaluate(
      retiring,
      context({
        timestamp: new Date('2026-08-18T14:20:00.000Z'),
        hasOpenPosition: true,
        positionStrategyVersion: '1.0.0',
        indicators: { 'ema.fast': 98, 'ema.slow': 100, adx: 15 },
      }),
    );
    expect(managed.signal?.type).toBe('EXIT');
  });

  it('selects the active implementation from observable market regime', () => {
    const strategies = [
      createTrendStrategy(metadata),
      createMeanReversionStrategy(metadata),
      createBreakoutStrategy(metadata),
    ];
    expect(selectStrategyForRegime(strategies, context())?.id).toBe('trend-following');
    expect(
      selectStrategyForRegime(strategies, context({ indicators: { adx: 12, volatility: 0.25 } }))
        ?.id,
    ).toBe('mean-reversion');
    expect(selectStrategyForRegime(strategies, context({ eventRisk: 'BLOCKED' }))).toBeUndefined();
  });

  it('covers trend hold, warmup, entry and exit decisions', () => {
    const strategy = createTrendStrategy(metadata);
    expect(strategy.evaluate(context({ indicators: {} })).type).toBe('HOLD');
    expect(
      strategy.evaluate(context({ indicators: { 'ema.fast': 99, 'ema.slow': 100, adx: 30 } })).type,
    ).toBe('HOLD');
    expect(strategy.evaluate(context()).type).toBe('BUY');
    expect(
      strategy.evaluate(
        context({
          hasOpenPosition: true,
          indicators: { 'ema.fast': 101, 'ema.slow': 100, adx: 10 },
        }),
      ).type,
    ).toBe('EXIT');
  });

  it('covers mean-reversion warmup, hold, entry and exit decisions', () => {
    const strategy = createMeanReversionStrategy(metadata);
    expect(strategy.evaluate(context({ indicators: {} })).type).toBe('HOLD');
    expect(
      strategy.evaluate(
        context({
          price: 90,
          indicators: { rsi: 20, 'bollinger.lower': 91, 'bollinger.middle': 100, adx: 18 },
        }),
      ).type,
    ).toBe('BUY');
    expect(
      strategy.evaluate(
        context({
          hasOpenPosition: true,
          price: 101,
          indicators: { rsi: 40, 'bollinger.lower': 90, 'bollinger.middle': 100, adx: 18 },
        }),
      ).type,
    ).toBe('EXIT');
    expect(
      strategy.evaluate(
        context({
          price: 95,
          indicators: { rsi: 40, 'bollinger.lower': 90, 'bollinger.middle': 100, adx: 18 },
        }),
      ).type,
    ).toBe('HOLD');
  });

  it('covers breakout warmup, volume rejection, entry and hold decisions', () => {
    const strategy = createBreakoutStrategy(metadata);
    expect(strategy.evaluate(context({ indicators: {} })).type).toBe('HOLD');
    expect(
      strategy.evaluate(
        context({ price: 101, indicators: { 'rolling.high': 100, 'volume.ratio': 1, atr: 2 } }),
      ).type,
    ).toBe('HOLD');
    expect(
      strategy.evaluate(
        context({ price: 101, indicators: { 'rolling.high': 100, 'volume.ratio': 2, atr: 2 } }),
      ).type,
    ).toBe('BUY');
    expect(
      strategy.evaluate(
        context({ price: 99, indicators: { 'rolling.high': 100, 'volume.ratio': 2, atr: 2 } }),
      ).type,
    ).toBe('HOLD');
  });
});
