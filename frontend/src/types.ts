import type { HealthState, SystemState, TradingMode } from '@aegis/shared';

export interface ServiceStatus {
  readonly name: string;
  readonly state: HealthState;
  readonly detail: string;
  readonly latencyMs?: number;
  readonly lastSuccessAt?: string;
}

export interface PositionView {
  readonly id: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly averageEntryPrice: string;
  readonly currentPrice: string;
  readonly marketValue: string;
  readonly unrealizedPnl: string;
  readonly realizedPnl: string;
  readonly exposurePercent: string;
  readonly strategy: string;
  readonly strategyVersion: string;
  readonly stopPrice?: string;
  readonly targetPrice?: string;
  readonly reconciliation: 'MATCHED' | 'REVIEW' | 'MISMATCH';
}

export interface OrderView {
  readonly id: string;
  readonly clientOrderId: string;
  readonly brokerOrderId?: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: string;
  readonly state: string;
  readonly quantity: string;
  readonly filledQuantity: string;
  readonly averageFillPrice?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timeline: readonly TimelineEvent[];
}

export interface TradeView {
  readonly id: string;
  readonly symbol: string;
  readonly strategy: string;
  readonly strategyVersion: string;
  readonly state: string;
  readonly entryPrice: string;
  readonly exitPrice?: string;
  readonly quantity: string;
  readonly pnl: string;
  readonly pnlPercent: string;
  readonly risk: string;
  readonly duration: string;
  readonly entryReason: string;
  readonly exitReason?: string;
  readonly correlationId: string;
  readonly timeline: readonly TimelineEvent[];
}

export interface TimelineEvent {
  readonly id: string;
  readonly type: string;
  readonly detail: string;
  readonly occurredAt: string;
}

export interface AlertView {
  readonly id: string;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
  readonly state: 'PENDING' | 'SENT' | 'FAILED' | 'ACKNOWLEDGED';
  readonly title: string;
  readonly component: string;
  readonly occurredAt: string;
}

export interface WatchlistItem {
  readonly symbol: string;
  readonly active: boolean;
  readonly tradable: boolean;
  readonly lastPrice?: string;
  readonly blockedReason?: string;
  readonly scannerScore?: string;
  readonly scannerSignal?: string;
}

export interface ScanRun {
  readonly id: string;
  readonly status: string;
  readonly trigger: string;
  readonly startedAt: string;
  readonly durationMs?: number;
  readonly candidates: number;
  readonly rejections: number;
  readonly errors: number;
}

export interface RiskView {
  readonly configurationVersion: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly usedPercent: string;
  readonly availablePercent: string;
  readonly dailyLossPercent: string;
  readonly dailyLossLimitPercent: string;
  readonly drawdownPercent: string;
  readonly maximumDrawdownPercent: string;
  readonly exposurePercent: string;
  readonly maximumExposurePercent: string;
  readonly concentrationPercent: string;
  readonly positionCount: number;
  readonly maximumPositions: number;
  readonly dailyTradeCount: number;
  readonly maximumDailyTrades: number;
  readonly recentRejections: readonly TimelineEvent[];
}

export interface SchedulerView {
  readonly state: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'BLOCKED';
  readonly intervalMs: number;
  readonly nextExecutionAt?: string;
  readonly lastExecutionAt?: string;
  readonly history: readonly ScanRun[];
}

export interface BacktestView {
  readonly id: string;
  readonly strategy: string;
  readonly strategyVersion: string;
  readonly symbol: string;
  readonly range: string;
  readonly netProfit: string;
  readonly winRate: string;
  readonly profitFactor: string;
  readonly expectancy: string;
  readonly sharpe: string;
  readonly maximumDrawdown: string;
  readonly equityCurve: readonly { readonly timestamp: string; readonly equity: number }[];
}

export interface LogView {
  readonly id: string;
  readonly level: string;
  readonly component: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly symbol?: string;
  readonly orderId?: string;
  readonly occurredAt: string;
}

export interface OperationsSnapshot {
  readonly generatedAt: string;
  readonly mode: TradingMode;
  readonly systemState: SystemState;
  readonly tradingEnabled: boolean;
  readonly entriesEnabled: boolean;
  readonly onlyClose: boolean;
  readonly killSwitch: boolean;
  readonly freshness: {
    readonly accountAsOf?: string;
    readonly positionsAsOf?: string;
    readonly marketDataAsOf?: string;
    readonly reconciliationAsOf?: string;
  };
  readonly account: {
    readonly status: string;
    readonly equity: string;
    readonly cash: string;
    readonly buyingPower: string;
    readonly dailyPnl: string;
    readonly drawdownPercent: string;
    readonly marketClock: string;
    readonly nextMarketEvent: string;
  };
  readonly services: readonly ServiceStatus[];
  readonly exposurePercent: string;
  readonly positions: readonly PositionView[];
  readonly orders: readonly OrderView[];
  readonly trades: readonly TradeView[];
  readonly alerts: readonly AlertView[];
  readonly watchlist: readonly WatchlistItem[];
  readonly scanner: {
    readonly state: string;
    readonly nextExecutionAt?: string;
    readonly lastExecutionAt?: string;
    readonly history: readonly ScanRun[];
    readonly rejections: readonly TimelineEvent[];
  };
  readonly risk: RiskView;
  readonly safety: {
    readonly version: number;
    readonly activeBlocks: readonly TimelineEvent[];
    readonly circuitBreakers: readonly TimelineEvent[];
    readonly history: readonly TimelineEvent[];
  };
  readonly scheduler: SchedulerView;
  readonly backtests: readonly BacktestView[];
  readonly backtestJobs: readonly {
    readonly id: string;
    readonly status: string;
    readonly progress: number;
    readonly error?: string;
    readonly runId?: string;
    readonly createdAt: string;
  }[];
  readonly logs: readonly LogView[];
  readonly reconciliationHistory: readonly TimelineEvent[];
}
