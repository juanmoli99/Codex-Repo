import type { MarketBar } from '../market-data/types.js';

export type IndicatorSeries = readonly (number | null)[];

export interface IndicatorDefinition<TInput, TParameters, TResult> {
  readonly id: string;
  readonly minimumSamples: (parameters: TParameters) => number;
  readonly validate: (input: readonly TInput[], parameters: TParameters) => void;
  readonly calculate: (input: readonly TInput[], parameters: TParameters) => TResult;
}

export class IndicatorRegistry {
  private readonly definitions = new Map<string, IndicatorDefinition<unknown, unknown, unknown>>();

  public register<TInput, TParameters, TResult>(
    definition: IndicatorDefinition<TInput, TParameters, TResult>,
  ): void {
    if (this.definitions.has(definition.id))
      throw new Error(`Indicator already registered: ${definition.id}`);
    this.definitions.set(
      definition.id,
      definition as IndicatorDefinition<unknown, unknown, unknown>,
    );
  }

  public has(id: string): boolean {
    return this.definitions.has(id);
  }
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period <= 0)
    throw new Error('Period must be a positive integer');
}

function assertFiniteSeries(values: readonly number[]): void {
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error('Indicator input must be finite');
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing value at index ${index}`);
  return value;
}

function requiredNumber(values: IndicatorSeries, index: number): number {
  const value = requiredAt(values, index);
  if (value === null) throw new Error(`Indicator is not warmed up at index ${index}`);
  return value;
}

export function sma(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period);
  assertFiniteSeries(values);
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += requiredAt(values, index);
    if (index >= period) sum -= requiredAt(values, index - period);
    if (index >= period - 1) result[index] = sum / period;
  }
  return result;
}

export function ema(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period);
  assertFiniteSeries(values);
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  if (values.length < period) return result;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = seed;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    const previous = requiredNumber(result, index - 1);
    result[index] = (requiredAt(values, index) - previous) * multiplier + previous;
  }
  return result;
}

export function returns(values: readonly number[]): IndicatorSeries {
  assertFiniteSeries(values);
  const result: (number | null)[] = [null];
  for (let index = 1; index < values.length; index += 1) {
    const previous = requiredAt(values, index - 1);
    result.push(previous === 0 ? null : requiredAt(values, index) / previous - 1);
  }
  return result;
}

export function rsi(values: readonly number[], period = 14): IndicatorSeries {
  assertPeriod(period);
  assertFiniteSeries(values);
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  if (values.length <= period) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = requiredAt(values, index) - requiredAt(values, index - 1);
    averageGain += Math.max(0, change);
    averageLoss += Math.max(0, -change);
  }
  averageGain /= period;
  averageLoss /= period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = requiredAt(values, index) - requiredAt(values, index - 1);
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

export function trueRange(bars: readonly MarketBar[]): readonly number[] {
  if (bars.length === 0) return [];
  return bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = requiredAt(bars, index - 1).close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
}

function wilders(values: readonly number[], period: number, startIndex: number): IndicatorSeries {
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  if (values.length < startIndex + period) return result;
  let average =
    values.slice(startIndex, startIndex + period).reduce((sum, value) => sum + value, 0) / period;
  const seedIndex = startIndex + period - 1;
  result[seedIndex] = average;
  for (let index = seedIndex + 1; index < values.length; index += 1) {
    average = (average * (period - 1) + requiredAt(values, index)) / period;
    result[index] = average;
  }
  return result;
}

export function atr(bars: readonly MarketBar[], period = 14): IndicatorSeries {
  assertPeriod(period);
  return wilders(trueRange(bars), period, 0);
}

export interface MacdResult {
  readonly macd: IndicatorSeries;
  readonly signal: IndicatorSeries;
  readonly histogram: IndicatorSeries;
}

export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  if (fastPeriod >= slowPeriod) throw new Error('MACD fast period must be less than slow period');
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdValues = values.map((_, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    return typeof fastValue === 'number' && typeof slowValue === 'number'
      ? fastValue - slowValue
      : null;
  });
  const compact = macdValues.filter((value): value is number => value !== null);
  const compactSignal = ema(compact, signalPeriod);
  const signal: (number | null)[] = Array.from({ length: values.length }, () => null);
  let compactIndex = 0;
  for (let index = 0; index < macdValues.length; index += 1) {
    if (macdValues[index] !== null) {
      signal[index] = compactSignal[compactIndex] ?? null;
      compactIndex += 1;
    }
  }
  const histogram = macdValues.map((value, index) => {
    const signalValue = signal[index];
    return value === null || typeof signalValue !== 'number' ? null : value - signalValue;
  });
  return { macd: macdValues, signal, histogram };
}

export interface BollingerBandsResult {
  readonly middle: IndicatorSeries;
  readonly upper: IndicatorSeries;
  readonly lower: IndicatorSeries;
}

export function bollingerBands(
  values: readonly number[],
  period = 20,
  standardDeviations = 2,
): BollingerBandsResult {
  assertPeriod(period);
  const middle = sma(values, period);
  const upper: (number | null)[] = Array.from({ length: values.length }, () => null);
  const lower: (number | null)[] = Array.from({ length: values.length }, () => null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const mean = requiredNumber(middle, index);
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * standardDeviations;
    upper[index] = mean + deviation;
    lower[index] = mean - deviation;
  }
  return { middle, upper, lower };
}

export function cumulativeVwap(bars: readonly MarketBar[]): IndicatorSeries {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  return bars.map((bar) => {
    if (!Number.isFinite(bar.volume) || bar.volume < 0)
      throw new Error('Volume must be non-negative');
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativePriceVolume += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
    return cumulativeVolume === 0 ? null : cumulativePriceVolume / cumulativeVolume;
  });
}

export interface AdxResult {
  readonly adx: IndicatorSeries;
  readonly plusDi: IndicatorSeries;
  readonly minusDi: IndicatorSeries;
}

export function adx(bars: readonly MarketBar[], period = 14): AdxResult {
  assertPeriod(period);
  const tr = trueRange(bars);
  const plusDm = bars.map((bar, index) => {
    if (index === 0) return 0;
    const previous = requiredAt(bars, index - 1);
    const up = bar.high - previous.high;
    const down = previous.low - bar.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm = bars.map((bar, index) => {
    if (index === 0) return 0;
    const previous = requiredAt(bars, index - 1);
    const up = bar.high - previous.high;
    const down = previous.low - bar.low;
    return down > up && down > 0 ? down : 0;
  });
  const atrValues = wilders(tr, period, 1);
  const plusSmoothed = wilders(plusDm, period, 1);
  const minusSmoothed = wilders(minusDm, period, 1);
  const plusDi = bars.map((_, index) => {
    const atrValue = atrValues[index];
    const smoothed = plusSmoothed[index];
    return typeof atrValue === 'number' && atrValue !== 0 && typeof smoothed === 'number'
      ? (100 * smoothed) / atrValue
      : null;
  });
  const minusDi = bars.map((_, index) => {
    const atrValue = atrValues[index];
    const smoothed = minusSmoothed[index];
    return typeof atrValue === 'number' && atrValue !== 0 && typeof smoothed === 'number'
      ? (100 * smoothed) / atrValue
      : null;
  });
  const dx = bars.map((_, index) => {
    const plus = plusDi[index];
    const minus = minusDi[index];
    if (
      plus === null ||
      plus === undefined ||
      minus === null ||
      minus === undefined ||
      plus + minus === 0
    )
      return 0;
    return (100 * Math.abs(plus - minus)) / (plus + minus);
  });
  return { adx: wilders(dx, period, period), plusDi, minusDi };
}

export function averageVolume(bars: readonly MarketBar[], period = 20): IndicatorSeries {
  return sma(
    bars.map((bar) => bar.volume),
    period,
  );
}

export function rollingVolatility(
  values: readonly number[],
  period = 20,
  annualizationFactor = 252,
): IndicatorSeries {
  const valueReturns = returns(values);
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  for (let index = period; index < values.length; index += 1) {
    const window = valueReturns.slice(index - period + 1, index + 1);
    if (window.some((value) => value === null)) continue;
    const numeric = window as number[];
    const mean = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
    const variance =
      numeric.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (numeric.length - 1);
    result[index] = Math.sqrt(variance * annualizationFactor);
  }
  return result;
}

export function rollingHigh(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period);
  return values.map((_, index) =>
    index < period - 1 ? null : Math.max(...values.slice(index - period + 1, index + 1)),
  );
}

export function rollingLow(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period);
  return values.map((_, index) =>
    index < period - 1 ? null : Math.min(...values.slice(index - period + 1, index + 1)),
  );
}

export interface CrossResult {
  readonly crossedAbove: readonly boolean[];
  readonly crossedBelow: readonly boolean[];
}

export function detectCrosses(left: IndicatorSeries, right: IndicatorSeries): CrossResult {
  if (left.length !== right.length) throw new Error('Cross series must have equal lengths');
  const crossedAbove = left.map((value, index) => {
    const rightValue = right[index];
    if (index === 0 || value === null || rightValue === null || rightValue === undefined)
      return false;
    const previousLeft = left[index - 1];
    const previousRight = right[index - 1];
    return (
      previousLeft !== null &&
      previousLeft !== undefined &&
      previousRight !== null &&
      previousRight !== undefined &&
      previousLeft <= previousRight &&
      value > rightValue
    );
  });
  const crossedBelow = left.map((value, index) => {
    const rightValue = right[index];
    if (index === 0 || value === null || rightValue === null || rightValue === undefined)
      return false;
    const previousLeft = left[index - 1];
    const previousRight = right[index - 1];
    return (
      previousLeft !== null &&
      previousLeft !== undefined &&
      previousRight !== null &&
      previousRight !== undefined &&
      previousLeft >= previousRight &&
      value < rightValue
    );
  });
  return { crossedAbove, crossedBelow };
}
