import { describe, expect, it } from 'vitest';

import type { MarketBar } from './types.js';
import { MarketDataHealthService, MarketDataValidator } from './validator.js';

function bar(timestamp: number, close = 100): MarketBar {
  return {
    symbol: 'SPY',
    timestamp: new Date(timestamp),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
  };
}

const policy = {
  maximumAgeMs: 120_000,
  futureToleranceMs: 1_000,
  maximumGapMultiplier: 1.5,
  maximumPriceChangeFraction: 0.2,
  minimumBars: 2,
};

describe('MarketDataValidator', () => {
  it('accepts coherent chronological bars', () => {
    const now = Date.parse('2026-08-18T14:02:00Z');
    const result = new MarketDataValidator(() => now).validateBars(
      'SPY',
      '1Min',
      [bar(now - 60_000), bar(now - 120_000)],
      policy,
    );
    expect(result.health).toBe('HEALTHY');
    expect(result.anomalies).toHaveLength(0);
  });

  it('blocks duplicate, invalid OHLC, missing, future, and stale data', () => {
    const now = Date.parse('2026-08-18T14:10:00Z');
    const invalid = { ...bar(now - 600_000), high: 90, low: 110 };
    const result = new MarketDataValidator(() => now).validateBars(
      'SPY',
      '1Min',
      [invalid, invalid, bar(now + 5_000, 200)],
      policy,
    );
    expect(result.health).toBe('INCONSISTENT');
    expect(result.anomalies.map((anomaly) => anomaly.code)).toEqual(
      expect.arrayContaining([
        'DUPLICATE_BAR',
        'OHLC_INCONSISTENT',
        'MISSING_BARS',
        'FUTURE_BAR',
        'PRICE_SANITY_BREACH',
      ]),
    );
  });

  it('requires warm-up after reconnection', () => {
    const now = Date.parse('2026-08-18T14:02:00Z');
    const validation = new MarketDataValidator(() => now).validateBars(
      'SPY',
      '1Min',
      [bar(now - 60_000), bar(now - 120_000)],
      policy,
    );
    const health = new MarketDataHealthService();
    health.beginWarmup('SPY');
    expect(health.recordValidation('SPY', validation, 4).health).toBe('UNAVAILABLE');
    expect(health.recordValidation('SPY', validation, 4).health).toBe('HEALTHY');
    expect(health.canOpen('SPY')).toBe(true);
  });
});
