import { describe, expect, it, vi } from 'vitest';
import { ExecutionCoordinator, IdempotencyRegistry } from './coordinator.js';

describe('concurrency controls', () => {
  it('coalesces retries under one idempotency key', async () => {
    const registry = new IdempotencyRegistry<number>();
    const operation = vi.fn(async () => 42);
    const results = await Promise.all([
      registry.execute('key', operation),
      registry.execute('key', operation),
      registry.execute('key', operation),
    ]);
    expect(results).toEqual([42, 42, 42]);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('acquires ordered distributed leases and exposes fencing tokens', async () => {
    const released: string[] = [];
    const coordinator = new ExecutionCoordinator(
      {
        acquire: async (name, ownerId) => ({ name, ownerId, fencingToken: BigInt(name.length) }),
        isCurrent: async () => true,
        release: async (lease) => {
          released.push(lease.name);
          return true;
        },
      },
      'worker-1',
    );
    const result = await coordinator.exclusively(
      ['symbol:AAPL', 'scheduler'],
      30_000,
      async (tokens) => Object.keys(tokens),
    );
    expect(result).toEqual(['scheduler', 'symbol:AAPL']);
    expect(released).toEqual(['symbol:AAPL', 'scheduler']);
  });
});
