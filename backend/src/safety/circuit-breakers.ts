export type CircuitScope = 'GLOBAL' | 'BROKER' | 'MARKET_DATA' | 'STRATEGY' | 'SYMBOL';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerSnapshot {
  readonly key: string;
  readonly scope: CircuitScope;
  readonly scopeId?: string;
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly threshold: number;
  readonly reason?: string;
  readonly openedAt?: Date;
  readonly cooldownUntil?: Date;
  readonly lastFailureAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly version: number;
}

export interface CircuitBreakerRepository {
  find(key: string): Promise<CircuitBreakerSnapshot | undefined>;
  save(snapshot: CircuitBreakerSnapshot): Promise<void>;
  listOpen(): Promise<readonly CircuitBreakerSnapshot[]>;
}

function key(scope: CircuitScope, scopeId?: string): string {
  return `${scope}:${scopeId ?? '*'}`;
}

export class PersistentCircuitBreakerService {
  public constructor(private readonly repository: CircuitBreakerRepository) {}

  public async allows(scope: CircuitScope, scopeId?: string, at = new Date()): Promise<boolean> {
    const snapshot = await this.repository.find(key(scope, scopeId));
    if (!snapshot || snapshot.state === 'CLOSED') return true;
    if (snapshot.cooldownUntil && at >= snapshot.cooldownUntil) {
      await this.repository.save({
        ...snapshot,
        state: 'HALF_OPEN',
        version: snapshot.version + 1,
      });
    }
    return false;
  }

  public async recordFailure(input: {
    scope: CircuitScope;
    scopeId?: string;
    reason: string;
    threshold: number;
    cooldownMs: number;
    at?: Date;
  }): Promise<CircuitBreakerSnapshot> {
    const at = input.at ?? new Date();
    const breakerKey = key(input.scope, input.scopeId);
    const prior = await this.repository.find(breakerKey);
    const failureCount = (prior?.failureCount ?? 0) + 1;
    const open = failureCount >= input.threshold || prior?.state === 'OPEN';
    const snapshot: CircuitBreakerSnapshot = {
      key: breakerKey,
      scope: input.scope,
      ...(input.scopeId ? { scopeId: input.scopeId } : {}),
      state: open ? 'OPEN' : 'CLOSED',
      failureCount,
      threshold: input.threshold,
      reason: input.reason,
      ...(open ? { openedAt: prior?.openedAt ?? at } : {}),
      ...(open ? { cooldownUntil: new Date(at.getTime() + input.cooldownMs) } : {}),
      lastFailureAt: at,
      ...(prior?.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {}),
      version: (prior?.version ?? 0) + 1,
    };
    await this.repository.save(snapshot);
    return snapshot;
  }

  public async recordSuccess(
    scope: CircuitScope,
    scopeId?: string,
    at = new Date(),
  ): Promise<void> {
    const breakerKey = key(scope, scopeId);
    const prior = await this.repository.find(breakerKey);
    if (!prior) return;
    await this.repository.save({
      ...prior,
      state: 'CLOSED',
      failureCount: 0,
      lastSuccessAt: at,
      version: prior.version + 1,
    });
  }

  public listOpen(): Promise<readonly CircuitBreakerSnapshot[]> {
    return this.repository.listOpen();
  }
}
