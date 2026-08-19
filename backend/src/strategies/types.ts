export type SignalType = 'BUY' | 'SELL' | 'HOLD' | 'EXIT';
export type StrategyLifecycle = 'ACTIVE' | 'RETIRING' | 'DISABLED';

export interface IndicatorRequirement {
  readonly id: string;
  readonly parameters: Readonly<Record<string, number | string>>;
}

export interface StrategyContext {
  readonly symbol: string;
  readonly timestamp: Date;
  readonly timeframe: '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';
  readonly price: number;
  readonly indicators: Readonly<Record<string, number | null>>;
  readonly hasOpenPosition: boolean;
  readonly positionStrategyVersion?: string;
  readonly eventRisk: 'NONE' | 'ELEVATED' | 'BLOCKED';
}

export interface SignalProposal {
  readonly type: SignalType;
  readonly reason: string;
  readonly confidence?: number;
  readonly expectedEdgeBps?: number;
  readonly expiresAt: Date;
}

export interface StrategyDefinition {
  readonly id: string;
  readonly version: string;
  readonly configurationVersion: string;
  readonly deploymentId: string;
  readonly lifecycle: StrategyLifecycle;
  readonly timeframe: '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';
  readonly sessionPolicy: 'REGULAR_ONLY' | 'EXTENDED_ALLOWED';
  readonly overnightPolicy: 'FLAT_AT_CLOSE' | 'ALLOW';
  readonly eventRiskPolicy: 'BLOCK_ENTRIES' | 'REDUCE_SIZE' | 'IGNORE';
  readonly parameters: Readonly<Record<string, number | string | boolean>>;
  readonly requiredIndicators: readonly IndicatorRequirement[];
  readonly cooldownMs: number;
  readonly maximumSignalsPerDay: number;
  readonly maximumTradesPerDay: number;
  readonly assetOverrides?: Readonly<
    Record<string, Readonly<Record<string, number | string | boolean>>>
  >;
  evaluate(context: StrategyContext): SignalProposal;
}

export interface StrategySignal {
  readonly id: string;
  readonly timestamp: Date;
  readonly symbol: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly configurationVersion: string;
  readonly deploymentId: string;
  readonly type: SignalType;
  readonly reason: string;
  readonly confidence?: number;
  readonly expectedEdgeBps?: number;
  readonly expiresAt: Date;
  readonly parametersSnapshot: Readonly<Record<string, number | string | boolean>>;
  readonly configurationSnapshot: Readonly<Record<string, unknown>>;
  readonly deduplicationKey: string;
}

export interface SignalRejection {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly symbol: string;
  readonly code:
    | 'STRATEGY_NOT_ACTIVE'
    | 'TIMEFRAME_MISMATCH'
    | 'POSITION_VERSION_MISMATCH'
    | 'SIGNAL_EXPIRED'
    | 'DUPLICATE_SIGNAL'
    | 'COOLDOWN_ACTIVE'
    | 'DAILY_SIGNAL_LIMIT'
    | 'ABNORMAL_OUTPUT';
  readonly detail: string;
}

export interface StrategyEvaluation {
  readonly signal?: StrategySignal;
  readonly rejection?: SignalRejection;
}

export interface PositionVersionMigration {
  readonly id: string;
  readonly symbol: string;
  readonly strategyId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly migratedAt: Date;
}
