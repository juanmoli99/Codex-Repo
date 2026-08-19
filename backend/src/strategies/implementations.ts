import type {
  SignalProposal,
  StrategyContext,
  StrategyDefinition,
  StrategyLifecycle,
} from './types.js';

interface StrategyMetadata {
  readonly version: string;
  readonly configurationVersion: string;
  readonly deploymentId: string;
  readonly lifecycle?: StrategyLifecycle;
}

function expiry(context: StrategyContext, minutes: number): Date {
  return new Date(context.timestamp.getTime() + minutes * 60_000);
}

function value(context: StrategyContext, key: string): number | null {
  return context.indicators[key] ?? null;
}

function hold(context: StrategyContext, reason: string): SignalProposal {
  return { type: 'HOLD', reason, expiresAt: expiry(context, 5) };
}

const commonLimits = {
  cooldownMs: 15 * 60_000,
  maximumSignalsPerDay: 20,
  maximumTradesPerDay: 5,
} as const;

export function createTrendStrategy(metadata: StrategyMetadata): StrategyDefinition {
  const parameters = { fastPeriod: 20, slowPeriod: 50, minimumAdx: 25, exitAdx: 18 } as const;
  return {
    id: 'trend-following',
    ...metadata,
    lifecycle: metadata.lifecycle ?? 'ACTIVE',
    timeframe: '1Min',
    sessionPolicy: 'REGULAR_ONLY',
    overnightPolicy: 'FLAT_AT_CLOSE',
    eventRiskPolicy: 'BLOCK_ENTRIES',
    parameters,
    requiredIndicators: [
      { id: 'ema.fast', parameters: { period: parameters.fastPeriod } },
      { id: 'ema.slow', parameters: { period: parameters.slowPeriod } },
      { id: 'adx', parameters: { period: 14 } },
    ],
    ...commonLimits,
    evaluate(context) {
      const fast = value(context, 'ema.fast');
      const slow = value(context, 'ema.slow');
      const adx = value(context, 'adx');
      if (fast === null || slow === null || adx === null)
        return hold(context, 'Indicators are not warmed up');
      if (context.hasOpenPosition && (fast < slow || adx < parameters.exitAdx))
        return {
          type: 'EXIT',
          reason: 'Trend weakened below the configured exit threshold',
          confidence: 0.8,
          expiresAt: expiry(context, 3),
        };
      if (!context.hasOpenPosition && fast > slow && adx >= parameters.minimumAdx)
        return {
          type: 'BUY',
          reason: 'Fast EMA is above slow EMA with confirmed trend strength',
          confidence: Math.min(0.95, 0.55 + adx / 100),
          expectedEdgeBps: Math.max(0, ((fast - slow) / context.price) * 10_000),
          expiresAt: expiry(context, 3),
        };
      return hold(context, 'No confirmed trend setup');
    },
  };
}

export function createMeanReversionStrategy(metadata: StrategyMetadata): StrategyDefinition {
  const parameters = { entryRsi: 28, exitRsi: 52, maximumAdx: 22 } as const;
  return {
    id: 'mean-reversion',
    ...metadata,
    lifecycle: metadata.lifecycle ?? 'ACTIVE',
    timeframe: '1Min',
    sessionPolicy: 'REGULAR_ONLY',
    overnightPolicy: 'FLAT_AT_CLOSE',
    eventRiskPolicy: 'BLOCK_ENTRIES',
    parameters,
    requiredIndicators: [
      { id: 'rsi', parameters: { period: 14 } },
      { id: 'bollinger.lower', parameters: { period: 20, deviations: 2 } },
      { id: 'bollinger.middle', parameters: { period: 20, deviations: 2 } },
      { id: 'adx', parameters: { period: 14 } },
    ],
    ...commonLimits,
    evaluate(context) {
      const rsi = value(context, 'rsi');
      const lower = value(context, 'bollinger.lower');
      const middle = value(context, 'bollinger.middle');
      const adx = value(context, 'adx');
      if (rsi === null || lower === null || middle === null || adx === null)
        return hold(context, 'Indicators are not warmed up');
      if (context.hasOpenPosition && (context.price >= middle || rsi >= parameters.exitRsi))
        return {
          type: 'EXIT',
          reason: 'Price reverted to its statistical mean',
          confidence: 0.78,
          expiresAt: expiry(context, 3),
        };
      if (
        !context.hasOpenPosition &&
        context.price <= lower &&
        rsi <= parameters.entryRsi &&
        adx <= parameters.maximumAdx
      )
        return {
          type: 'BUY',
          reason: 'Oversold price below the lower band in a non-trending regime',
          confidence: Math.min(0.9, 0.6 + (parameters.entryRsi - rsi) / 100),
          expectedEdgeBps: Math.max(0, ((middle - context.price) / context.price) * 10_000),
          expiresAt: expiry(context, 2),
        };
      return hold(context, 'No statistically significant reversion setup');
    },
  };
}

export function createBreakoutStrategy(metadata: StrategyMetadata): StrategyDefinition {
  const parameters = { minimumVolumeRatio: 1.5, trailingExitAtr: 2.5 } as const;
  return {
    id: 'volatility-breakout',
    ...metadata,
    lifecycle: metadata.lifecycle ?? 'ACTIVE',
    timeframe: '1Min',
    sessionPolicy: 'REGULAR_ONLY',
    overnightPolicy: 'FLAT_AT_CLOSE',
    eventRiskPolicy: 'BLOCK_ENTRIES',
    parameters,
    requiredIndicators: [
      { id: 'rolling.high', parameters: { period: 20 } },
      { id: 'average.volume', parameters: { period: 20 } },
      { id: 'volume.ratio', parameters: { period: 20 } },
      { id: 'atr', parameters: { period: 14 } },
    ],
    ...commonLimits,
    evaluate(context) {
      const previousHigh = value(context, 'rolling.high');
      const volumeRatio = value(context, 'volume.ratio');
      const atr = value(context, 'atr');
      if (previousHigh === null || volumeRatio === null || atr === null)
        return hold(context, 'Indicators are not warmed up');
      if (!context.hasOpenPosition && context.price > previousHigh) {
        if (volumeRatio < parameters.minimumVolumeRatio)
          return hold(context, 'Breakout lacks volume confirmation');
        return {
          type: 'BUY',
          reason: 'Price broke its rolling high with volume confirmation',
          confidence: Math.min(0.9, 0.55 + volumeRatio / 10),
          expectedEdgeBps: Math.max(0, (atr / context.price) * 5_000),
          expiresAt: expiry(context, 1),
        };
      }
      return hold(context, 'No confirmed breakout');
    },
  };
}
