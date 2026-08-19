import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, type DatabaseClient } from '../database/client.js';
import { PersistentLockService } from '../database/locks.js';

const databaseUrl = process.env.DATABASE_URL;
const safeIntegrationDatabase = (() => {
  if (!databaseUrl) return false;
  try {
    return /(?:_ci|_test)$/.test(new URL(databaseUrl).pathname.slice(1));
  } catch {
    return false;
  }
})();

describe.runIf(safeIntegrationDatabase)('PostgreSQL integration', () => {
  let database: DatabaseClient;
  const lockName = `integration:${randomUUID()}`;

  beforeAll(async () => {
    if (databaseUrl === undefined)
      throw new Error('DATABASE_URL is required for integration tests');
    database = createPrismaClient(databaseUrl);
    await database.$connect();
  });

  afterAll(async () => {
    await database.distributedLock.deleteMany({ where: { name: lockName } });
    await database.$disconnect();
  });

  it('serializes two workers and enforces a monotonically increasing fencing token', async () => {
    const locks = new PersistentLockService(database);
    const [left, right] = await Promise.all([
      locks.acquire(lockName, 'worker-left', 30_000),
      locks.acquire(lockName, 'worker-right', 30_000),
    ]);
    const acquired = [left, right].filter((lock) => lock !== null);
    expect(acquired).toHaveLength(1);
    const first = acquired.at(0);
    if (first === undefined) throw new Error('Expected one acquired lock');
    await expect(locks.isCurrent(first)).resolves.toBe(true);
    await expect(locks.release(first)).resolves.toBe(true);

    const next = await locks.acquire(lockName, 'worker-next', 30_000);
    expect(next).not.toBeNull();
    if (next === null) throw new Error('Expected lock reacquisition');
    expect(next.fencingToken).toBeGreaterThan(first.fencingToken);
    await locks.release(next);
  });
});
