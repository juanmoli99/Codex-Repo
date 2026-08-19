interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export class MarketDataCache {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public constructor(private readonly now: () => number = Date.now) {}

  public async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value as T;
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const pending = loader()
      .then((value) => {
        this.cache.set(key, { value, expiresAt: this.now() + ttlMs });
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  public invalidateSymbol(symbol: string): void {
    const marker = `:${symbol.toUpperCase()}:`;
    for (const key of this.cache.keys()) {
      if (key.includes(marker)) this.cache.delete(key);
    }
  }

  public clear(): void {
    this.cache.clear();
  }
}
