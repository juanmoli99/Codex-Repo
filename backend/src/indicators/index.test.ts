import { describe, expect, it } from 'vitest';

import {
  bollingerBands,
  detectCrosses,
  ema,
  macd,
  returns,
  rsi,
  rollingHigh,
  sma,
} from './index.js';

describe('deterministic indicators', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('calculates SMA and EMA with explicit warm-up', () => {
    expect(sma(values, 3)).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ema(values, 3)).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('produces deterministic RSI, MACD, bands, returns, and rolling values', () => {
    expect(rsi(values, 3).at(-1)).toBe(100);
    expect(macd(values, 3, 5, 2)).toEqual(macd(values, 3, 5, 2));
    expect(bollingerBands(values, 3).middle.at(-1)).toBe(9);
    const calculatedReturns = returns([100, 110, 99]);
    expect(calculatedReturns[0]).toBeNull();
    expect(calculatedReturns[1]).toBeCloseTo(0.1, 12);
    expect(calculatedReturns[2]).toBeCloseTo(-0.1, 12);
    expect(rollingHigh(values, 3).at(-1)).toBe(10);
  });

  it('detects crosses without lookahead', () => {
    const result = detectCrosses([null, 1, 3, 1], [null, 2, 2, 2]);
    expect(result.crossedAbove).toEqual([false, false, true, false]);
    expect(result.crossedBelow).toEqual([false, false, false, true]);
  });
});
