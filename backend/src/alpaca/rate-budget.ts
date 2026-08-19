import { AppError } from '../core/errors.js';

export class RateBudgetExceededError extends AppError {
  public constructor() {
    super(
      'RATE_BUDGET_EXHAUSTED',
      'Shared Alpaca rate budget is exhausted',
      503,
      'DEPENDENCY',
      'WARNING',
      true,
    );
  }
}

export interface RateBudget {
  acquire(cost?: number, maximumWaitMs?: number, signal?: AbortSignal): Promise<void>;
}

export class SharedRateBudget implements RateBudget {
  private tokens: number;
  private lastRefillMs: number;

  public constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsedSeconds = Math.max(0, current - this.lastRefillMs) / 1_000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = current;
  }

  public available(): number {
    this.refill();
    return this.tokens;
  }

  public tryAcquire(cost = 1): boolean {
    if (!Number.isFinite(cost) || cost <= 0 || cost > this.capacity) return false;
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  public async acquire(cost = 1, maximumWaitMs = 2_000, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + maximumWaitMs;
    while (!this.tryAcquire(cost)) {
      if (signal?.aborted) throw signal.reason;
      const missing = cost - this.available();
      const waitMs = Math.max(1, Math.ceil((missing / this.refillPerSecond) * 1_000));
      if (this.now() + waitMs > deadline) throw new RateBudgetExceededError();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, waitMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Rate budget wait aborted'),
            );
          },
          { once: true },
        );
      });
    }
  }
}
