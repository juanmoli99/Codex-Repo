export interface Lease {
  readonly name: string;
  readonly ownerId: string;
  readonly fencingToken: bigint;
}

export interface LeaseProvider {
  acquire(name: string, ownerId: string, ttlMs: number, metadata?: object): Promise<Lease | null>;
  release(lease: Lease): Promise<boolean>;
  isCurrent(lease: Lease): Promise<boolean>;
}

export class ExecutionCoordinator {
  private readonly localKeys = new Set<string>();

  public constructor(
    private readonly leases: LeaseProvider,
    private readonly ownerId: string,
  ) {}

  public async exclusively<T>(
    keys: readonly string[],
    ttlMs: number,
    operation: (fencingTokens: Readonly<Record<string, bigint>>) => Promise<T>,
  ): Promise<T> {
    const normalized = [...new Set(keys)].sort();
    if (normalized.some((key) => this.localKeys.has(key)))
      throw new Error('LOCAL_CONCURRENCY_CONFLICT');
    normalized.forEach((key) => this.localKeys.add(key));
    const acquired: Lease[] = [];
    try {
      for (const key of normalized) {
        const lease = await this.leases.acquire(key, this.ownerId, ttlMs, {
          ownerId: this.ownerId,
        });
        if (lease === null) throw new Error(`DISTRIBUTED_LOCK_UNAVAILABLE:${key}`);
        acquired.push(lease);
      }
      if (
        (await Promise.all(acquired.map((lease) => this.leases.isCurrent(lease)))).some(
          (valid) => !valid,
        )
      )
        throw new Error('FENCING_TOKEN_EXPIRED');
      return await operation(
        Object.fromEntries(acquired.map((lease) => [lease.name, lease.fencingToken])),
      );
    } finally {
      for (const lease of acquired.reverse()) await this.leases.release(lease);
      normalized.forEach((key) => this.localKeys.delete(key));
    }
  }
}

export class IdempotencyRegistry<T> {
  private readonly completed = new Map<string, T>();
  private readonly running = new Map<string, Promise<T>>();

  public async execute(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.completed.get(key);
    if (prior !== undefined) return prior;
    const inFlight = this.running.get(key);
    if (inFlight !== undefined) return inFlight;
    const promise = operation()
      .then((result) => {
        this.completed.set(key, result);
        return result;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }
}
