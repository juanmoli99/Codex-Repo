import type { HealthComponent, HealthState, SystemState, TradingMode } from '@aegis/shared';

export type HealthCheckName =
  | 'application'
  | 'database'
  | 'alpaca'
  | 'market-data'
  | 'scheduler'
  | 'reconciliation'
  | 'operational-safety';

export interface ComponentCheckResult {
  readonly state: HealthState;
  readonly message?: string;
}

export interface DeepHealthReport {
  readonly status: HealthState;
  readonly systemState: SystemState;
  readonly mode: TradingMode;
  readonly checkedAt: Date;
  readonly components: readonly HealthComponent[];
}

export class HealthMonitor {
  public constructor(
    private readonly checks: Readonly<Record<HealthCheckName, () => Promise<ComponentCheckResult>>>,
    private readonly persistDegradedState: (report: DeepHealthReport) => Promise<void>,
  ) {}

  public async check(systemState: SystemState, mode: TradingMode): Promise<DeepHealthReport> {
    const entries = Object.entries(this.checks) as [
      HealthCheckName,
      () => Promise<ComponentCheckResult>,
    ][];
    const components = await Promise.all(
      entries.map(async ([name, check]): Promise<HealthComponent> => {
        const started = performance.now();
        try {
          const result = await check();
          return {
            name,
            state: result.state,
            checkedAt: new Date().toISOString(),
            latencyMs: Math.max(0, Math.round(performance.now() - started)),
            ...(result.message === undefined ? {} : { message: result.message }),
          };
        } catch (error) {
          return {
            name,
            state: 'DOWN',
            checkedAt: new Date().toISOString(),
            latencyMs: Math.max(0, Math.round(performance.now() - started)),
            message: error instanceof Error ? error.message : 'Health check failed',
          };
        }
      }),
    );
    const status: HealthState = components.some((component) => component.state === 'DOWN')
      ? 'DOWN'
      : components.some((component) => component.state === 'UNKNOWN')
        ? 'UNKNOWN'
        : components.some((component) => component.state === 'DEGRADED')
          ? 'DEGRADED'
          : 'UP';
    const report: DeepHealthReport = {
      status,
      systemState,
      mode,
      checkedAt: new Date(),
      components,
    };
    if (status !== 'UP') await this.persistDegradedState(report);
    return report;
  }
}
