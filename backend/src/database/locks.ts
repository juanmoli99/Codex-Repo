import type { DatabaseClient } from './client.js';

export interface AcquiredLock {
  readonly name: string;
  readonly ownerId: string;
  readonly fencingToken: bigint;
  readonly expiresAt: Date;
}

export class PersistentLockService {
  public constructor(private readonly database: DatabaseClient) {}

  public async acquire(
    name: string,
    ownerId: string,
    ttlMs: number,
    metadata?: object,
  ): Promise<AcquiredLock | null> {
    const expiresAt = new Date(Date.now() + ttlMs);
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        DELETE FROM "distributed_locks"
        WHERE "name" = ${name} AND "expiresAt" <= NOW()
      `;
      const rows = await transaction.$queryRaw<AcquiredLock[]>`
        INSERT INTO "distributed_locks" ("name", "ownerId", "expiresAt", "metadata")
        VALUES (${name}, ${ownerId}, ${expiresAt}, ${metadata ?? null}::jsonb)
        ON CONFLICT ("name") DO NOTHING
        RETURNING "name", "ownerId", "fencingToken", "expiresAt"
      `;
      return rows[0] ?? null;
    });
  }

  public async release(lock: AcquiredLock): Promise<boolean> {
    const result = await this.database.distributedLock.deleteMany({
      where: { name: lock.name, ownerId: lock.ownerId, fencingToken: lock.fencingToken },
    });
    return result.count === 1;
  }

  public async heartbeat(lock: AcquiredLock, ttlMs: number): Promise<AcquiredLock | null> {
    const expiresAt = new Date(Date.now() + ttlMs);
    const result = await this.database.distributedLock.updateMany({
      where: {
        name: lock.name,
        ownerId: lock.ownerId,
        fencingToken: lock.fencingToken,
        expiresAt: { gt: new Date() },
      },
      data: { heartbeatAt: new Date(), expiresAt },
    });
    return result.count === 1 ? { ...lock, expiresAt } : null;
  }

  public async isCurrent(lock: AcquiredLock): Promise<boolean> {
    return (
      (await this.database.distributedLock.count({
        where: {
          name: lock.name,
          ownerId: lock.ownerId,
          fencingToken: lock.fencingToken,
          expiresAt: { gt: new Date() },
        },
      })) === 1
    );
  }
}
