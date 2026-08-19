export const TIMEFRAMES = ['1Min', '5Min', '15Min', '1Hour', '1Day'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface MarketBar {
  readonly symbol: string;
  readonly timestamp: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly tradeCount?: number;
  readonly vwap?: number;
}

export interface MarketQuote {
  readonly symbol: string;
  readonly timestamp: Date;
  readonly bidPrice: number;
  readonly bidSize: number;
  readonly askPrice: number;
  readonly askSize: number;
}

export interface MarketTrade {
  readonly symbol: string;
  readonly timestamp: Date;
  readonly price: number;
  readonly size: number;
  readonly id: string;
}

export type MarketDataHealth = 'HEALTHY' | 'STALE' | 'UNAVAILABLE' | 'INCONSISTENT';

export interface MarketDataAnomaly {
  readonly code: string;
  readonly severity: 'WARNING' | 'CRITICAL';
  readonly symbol: string;
  readonly timestamp?: Date;
  readonly detail: string;
}

export interface MarketDataValidationResult {
  readonly health: MarketDataHealth;
  readonly bars: readonly MarketBar[];
  readonly anomalies: readonly MarketDataAnomaly[];
  readonly lastValidTimestamp?: Date;
}

export function timeframeMilliseconds(timeframe: Timeframe): number {
  switch (timeframe) {
    case '1Min':
      return 60_000;
    case '5Min':
      return 300_000;
    case '15Min':
      return 900_000;
    case '1Hour':
      return 3_600_000;
    case '1Day':
      return 86_400_000;
  }
}
