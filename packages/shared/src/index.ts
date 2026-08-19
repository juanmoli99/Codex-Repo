export const SYSTEM_STATES = ['READY', 'DEGRADED', 'BLOCKED', 'EMERGENCY'] as const;
export type SystemState = (typeof SYSTEM_STATES)[number];

export const TRADING_MODES = ['PAPER', 'LIVE'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export const HEALTH_STATES = ['UP', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface ApiErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
  };
}

export interface HealthComponent {
  readonly name: string;
  readonly state: HealthState;
  readonly checkedAt: string;
  readonly latencyMs?: number;
  readonly message?: string;
}

export interface HealthReport {
  readonly status: HealthState;
  readonly systemState: SystemState;
  readonly mode: TradingMode;
  readonly timestamp: string;
  readonly components: readonly HealthComponent[];
}
