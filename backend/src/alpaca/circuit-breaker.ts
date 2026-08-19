import { AppError } from '../core/errors.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends AppError {
  public constructor(readonly retryAt: Date) {
    super(
      'ALPACA_CIRCUIT_OPEN',
      'Alpaca circuit breaker is open',
      503,
      'DEPENDENCY',
      'CRITICAL',
      true,
    );
  }
}

export class CircuitBreaker {
  private stateValue: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;
  private halfOpenProbeActive = false;

  public constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  public state(): CircuitState {
    if (
      this.stateValue === 'OPEN' &&
      this.openedAtMs !== null &&
      this.now() - this.openedAtMs >= this.cooldownMs
    ) {
      this.stateValue = 'HALF_OPEN';
    }
    return this.stateValue;
  }

  public async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = this.state();
    if (state === 'OPEN' || (state === 'HALF_OPEN' && this.halfOpenProbeActive)) {
      throw new CircuitOpenError(new Date((this.openedAtMs ?? this.now()) + this.cooldownMs));
    }
    if (state === 'HALF_OPEN') this.halfOpenProbeActive = true;
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      this.halfOpenProbeActive = false;
    }
  }

  public onSuccess(): void {
    this.stateValue = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
  }

  public onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.stateValue === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.stateValue = 'OPEN';
      this.openedAtMs = this.now();
    }
  }

  public forceOpen(): void {
    this.stateValue = 'OPEN';
    this.openedAtMs = this.now();
  }
}
