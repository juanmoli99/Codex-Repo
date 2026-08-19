import type {
  MarketBar,
  MarketDataAnomaly,
  MarketDataHealth,
  MarketDataValidationResult,
  Timeframe,
} from './types.js';
import { timeframeMilliseconds } from './types.js';

export interface MarketDataValidationPolicy {
  readonly maximumAgeMs: number;
  readonly futureToleranceMs: number;
  readonly maximumGapMultiplier: number;
  readonly maximumPriceChangeFraction: number;
  readonly minimumBars: number;
  readonly isExpectedBarTime?: (timestamp: Date) => boolean;
}

export class MarketDataValidator {
  public constructor(private readonly now: () => number = Date.now) {}

  public validateBars(
    symbol: string,
    timeframe: Timeframe,
    input: readonly MarketBar[],
    policy: MarketDataValidationPolicy,
  ): MarketDataValidationResult {
    const anomalies: MarketDataAnomaly[] = [];
    const bars = [...input].sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
    );
    const seen = new Set<number>();
    let previous: MarketBar | undefined;

    if (bars.length < policy.minimumBars) {
      anomalies.push({
        code: 'INSUFFICIENT_BARS',
        severity: 'CRITICAL',
        symbol,
        detail: `Expected at least ${policy.minimumBars} bars, received ${bars.length}`,
      });
    }

    for (const bar of bars) {
      const timestamp = bar.timestamp.getTime();
      const prices = [bar.open, bar.high, bar.low, bar.close];
      if (!Number.isFinite(timestamp)) {
        anomalies.push({
          code: 'TIMESTAMP_INVALID',
          severity: 'CRITICAL',
          symbol,
          detail: 'Invalid timestamp',
        });
        continue;
      }
      if (seen.has(timestamp)) {
        anomalies.push({
          code: 'DUPLICATE_BAR',
          severity: 'CRITICAL',
          symbol,
          timestamp: bar.timestamp,
          detail: 'Duplicate timestamp',
        });
      }
      seen.add(timestamp);
      if (prices.some((price) => !Number.isFinite(price))) {
        anomalies.push({
          code: 'NON_FINITE_PRICE',
          severity: 'CRITICAL',
          symbol,
          timestamp: bar.timestamp,
          detail: 'OHLC contains NaN or Infinity',
        });
      } else if (prices.some((price) => price <= 0)) {
        anomalies.push({
          code: 'NON_POSITIVE_PRICE',
          severity: 'CRITICAL',
          symbol,
          timestamp: bar.timestamp,
          detail: 'OHLC price must be positive',
        });
      } else if (
        bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close, bar.high)
      ) {
        anomalies.push({
          code: 'OHLC_INCONSISTENT',
          severity: 'CRITICAL',
          symbol,
          timestamp: bar.timestamp,
          detail: 'OHLC ordering is inconsistent',
        });
      }
      if (!Number.isFinite(bar.volume) || bar.volume < 0) {
        anomalies.push({
          code: 'VOLUME_INVALID',
          severity: 'CRITICAL',
          symbol,
          timestamp: bar.timestamp,
          detail: 'Volume must be finite and non-negative',
        });
      }
      if (timestamp > this.now() + policy.futureToleranceMs) {
        anomalies.push({
          code: 'FUTURE_BAR',
          severity: 'CRITICAL',
          symbol,
          timestamp: bar.timestamp,
          detail: 'Bar timestamp is in the future',
        });
      }
      if (timeframe !== '1Day' && timestamp % timeframeMilliseconds(timeframe) !== 0) {
        anomalies.push({
          code: 'TIMEFRAME_MISALIGNED',
          severity: 'CRITICAL',
          symbol,
          timestamp: bar.timestamp,
          detail: `Timestamp is not aligned to ${timeframe}`,
        });
      }
      if (policy.isExpectedBarTime && !policy.isExpectedBarTime(bar.timestamp)) {
        anomalies.push({
          code: 'OUTSIDE_SESSION',
          severity: 'WARNING',
          symbol,
          timestamp: bar.timestamp,
          detail: 'Bar falls outside the configured market session',
        });
      }
      if (previous) {
        const gap = timestamp - previous.timestamp.getTime();
        const step = timeframeMilliseconds(timeframe);
        let expectedBarsMissing = false;
        if (gap > step * policy.maximumGapMultiplier) {
          if (policy.isExpectedBarTime) {
            const maximumChecks = Math.min(10_000, Math.floor(gap / step) - 1);
            for (let offset = 1; offset <= maximumChecks; offset += 1) {
              if (
                policy.isExpectedBarTime(new Date(previous.timestamp.getTime() + offset * step))
              ) {
                expectedBarsMissing = true;
                break;
              }
            }
          } else expectedBarsMissing = true;
        }
        if (timeframe !== '1Day' && expectedBarsMissing) {
          anomalies.push({
            code: 'MISSING_BARS',
            severity: 'CRITICAL',
            symbol,
            timestamp: bar.timestamp,
            detail: `Unexpected gap of ${gap}ms`,
          });
        }
        const changeFraction = Math.abs(bar.close - previous.close) / previous.close;
        if (Number.isFinite(changeFraction) && changeFraction > policy.maximumPriceChangeFraction) {
          anomalies.push({
            code: 'PRICE_SANITY_BREACH',
            severity: 'CRITICAL',
            symbol,
            timestamp: bar.timestamp,
            detail: `Close changed by ${(changeFraction * 100).toFixed(2)}%`,
          });
        }
      }
      previous = bar;
    }

    const lastValidTimestamp = bars.at(-1)?.timestamp;
    const stale =
      !lastValidTimestamp || this.now() - lastValidTimestamp.getTime() > policy.maximumAgeMs;
    if (stale) {
      anomalies.push({
        code: 'STALE_DATA',
        severity: 'CRITICAL',
        symbol,
        ...(lastValidTimestamp ? { timestamp: lastValidTimestamp } : {}),
        detail: 'Latest market data exceeds the maximum allowed age',
      });
    }
    const health: MarketDataHealth = anomalies.some(
      (anomaly) => anomaly.severity === 'CRITICAL' && anomaly.code !== 'STALE_DATA',
    )
      ? 'INCONSISTENT'
      : stale
        ? 'STALE'
        : 'HEALTHY';
    return Object.freeze({
      health,
      bars: Object.freeze(bars),
      anomalies: Object.freeze(anomalies),
      ...(lastValidTimestamp ? { lastValidTimestamp } : {}),
    });
  }
}

export interface MarketDataHealthSnapshot {
  readonly symbol: string;
  readonly health: MarketDataHealth;
  readonly lastValidTimestamp?: Date;
  readonly warmupBarsObserved: number;
  readonly updatedAt: Date;
}

export class MarketDataHealthService {
  private readonly states = new Map<string, MarketDataHealthSnapshot>();

  public markUnavailable(symbol: string): MarketDataHealthSnapshot {
    return this.update(symbol, 'UNAVAILABLE', undefined, 0);
  }

  public beginWarmup(symbol: string): MarketDataHealthSnapshot {
    return this.update(symbol, 'UNAVAILABLE', undefined, 0);
  }

  public recordValidation(
    symbol: string,
    result: MarketDataValidationResult,
    requiredWarmupBars: number,
  ): MarketDataHealthSnapshot {
    const previous = this.states.get(symbol);
    const observed =
      result.health === 'HEALTHY' ? (previous?.warmupBarsObserved ?? 0) + result.bars.length : 0;
    const health =
      result.health === 'HEALTHY' && observed < requiredWarmupBars ? 'UNAVAILABLE' : result.health;
    return this.update(symbol, health, result.lastValidTimestamp, observed);
  }

  public canOpen(symbol: string): boolean {
    return this.states.get(symbol)?.health === 'HEALTHY';
  }

  public current(symbol: string): MarketDataHealthSnapshot | undefined {
    return this.states.get(symbol);
  }

  private update(
    symbol: string,
    health: MarketDataHealth,
    lastValidTimestamp: Date | undefined,
    warmupBarsObserved: number,
  ): MarketDataHealthSnapshot {
    const snapshot: MarketDataHealthSnapshot = Object.freeze({
      symbol,
      health,
      ...(lastValidTimestamp ? { lastValidTimestamp } : {}),
      warmupBarsObserved,
      updatedAt: new Date(),
    });
    this.states.set(symbol, snapshot);
    return snapshot;
  }
}
