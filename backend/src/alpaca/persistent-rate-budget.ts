import { Decimal } from 'decimal.js';
import type { DatabaseClient } from '../database/client.js';
import { RateBudgetExceededError, type RateBudget } from './rate-budget.js';

interface BudgetRow {
  readonly tokens: Decimal;
  readonly capacity: Decimal;
  readonly refillPerSecond: Decimal;
  readonly lastRefillAt: Date;
}

export class PersistentRateBudget implements RateBudget {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly id: string,
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  public async acquire(cost = 1, maximumWaitMs = 2_000, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(cost) || cost <= 0 || cost > this.capacity)
      throw new RateBudgetExceededError();
    const deadline = Date.now() + maximumWaitMs;
    while (!(await this.tryAcquire(cost))) {
      if (signal?.aborted) throw signal.reason;
      const waitMs = Math.max(10, Math.ceil((cost / this.refillPerSecond) * 1_000));
      if (Date.now() + waitMs > deadline) throw new RateBudgetExceededError();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, waitMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(signal.reason instanceof Error ? signal.reason : new Error('Rate wait aborted'));
          },
          { once: true },
        );
      });
    }
  }

  private async tryAcquire(cost: number): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      await transaction.rateLimitBudgetRecord.upsert({
        where: { id: this.id },
        create: {
          id: this.id,
          tokens: this.capacity,
          capacity: this.capacity,
          refillPerSecond: this.refillPerSecond,
          lastRefillAt: new Date(),
        },
        update: {},
      });
      const rows = await transaction.$queryRaw<BudgetRow[]>`
        SELECT "tokens", "capacity", "refillPerSecond", "lastRefillAt"
        FROM "rate_limit_budgets" WHERE "id" = ${this.id} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return false;
      const now = new Date();
      const elapsedSeconds = Math.max(0, now.getTime() - row.lastRefillAt.getTime()) / 1_000;
      const available = Decimal.min(
        row.capacity,
        new Decimal(row.tokens).plus(new Decimal(row.refillPerSecond).mul(elapsedSeconds)),
      );
      const acquired = available.gte(cost);
      await transaction.rateLimitBudgetRecord.update({
        where: { id: this.id },
        data: { tokens: acquired ? available.minus(cost) : available, lastRefillAt: now },
      });
      return acquired;
    });
  }
}
