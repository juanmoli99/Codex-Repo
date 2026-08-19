import type { AlpacaAsset } from '../alpaca/types.js';

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

export interface WatchlistEntry {
  readonly symbol: string;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SymbolBlock {
  readonly symbol: string;
  readonly reason: string;
  readonly blockedAt: Date;
  readonly expiresAt?: Date;
}

export interface UniverseMetrics {
  readonly price: number;
  readonly averageVolume: number;
  readonly dollarVolume: number;
  readonly bidPrice: number;
  readonly askPrice: number;
}

export interface UniverseFilterPolicy {
  readonly minimumPrice: number;
  readonly maximumPrice: number;
  readonly minimumAverageVolume: number;
  readonly minimumDollarVolume: number;
  readonly maximumSpreadBps: number;
  readonly whitelist: ReadonlySet<string>;
  readonly blacklist: ReadonlySet<string>;
}

export interface UniverseDecision {
  readonly accepted: boolean;
  readonly spreadBps: number;
  readonly reasons: readonly string[];
}

export function normalizeSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(normalized)) throw new Error('Invalid US equity symbol');
  return normalized;
}

export class WatchlistService {
  private readonly entries = new Map<string, WatchlistEntry>();
  private readonly blocks = new Map<string, SymbolBlock>();

  public add(symbol: string): WatchlistEntry {
    const normalized = normalizeSymbol(symbol);
    const existing = this.entries.get(normalized);
    if (existing) return existing;
    const now = new Date();
    const entry = Object.freeze({
      symbol: normalized,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    this.entries.set(normalized, entry);
    return entry;
  }

  public remove(symbol: string): boolean {
    return this.entries.delete(normalizeSymbol(symbol));
  }

  public setActive(symbol: string, active: boolean): WatchlistEntry {
    const normalized = normalizeSymbol(symbol);
    const existing = this.entries.get(normalized);
    if (!existing) throw new Error('Symbol is not in the watchlist');
    const updated = Object.freeze({ ...existing, active, updatedAt: new Date() });
    this.entries.set(normalized, updated);
    return updated;
  }

  public block(symbol: string, reason: string, expiresAt?: Date): SymbolBlock {
    const normalized = normalizeSymbol(symbol);
    const block = Object.freeze({
      symbol: normalized,
      reason,
      blockedAt: new Date(),
      ...(expiresAt ? { expiresAt } : {}),
    });
    this.blocks.set(normalized, block);
    return block;
  }

  public currentBlock(symbol: string, now = new Date()): SymbolBlock | undefined {
    const normalized = normalizeSymbol(symbol);
    const block = this.blocks.get(normalized);
    if (block?.expiresAt && block.expiresAt <= now) {
      this.blocks.delete(normalized);
      return undefined;
    }
    return block;
  }

  public list(activeOnly = false): WatchlistEntry[] {
    return [...this.entries.values()]
      .filter((entry) => !activeOnly || entry.active)
      .sort((left, right) => left.symbol.localeCompare(right.symbol));
  }
}

export class UniverseFilter {
  public evaluate(
    asset: AlpacaAsset,
    metrics: UniverseMetrics,
    policy: UniverseFilterPolicy,
    blocked: boolean,
    halted: boolean,
  ): UniverseDecision {
    const reasons: string[] = [];
    const symbol = asset.symbol.toUpperCase();
    const midpoint = (metrics.askPrice + metrics.bidPrice) / 2;
    const spreadBps =
      midpoint > 0 ? ((metrics.askPrice - metrics.bidPrice) / midpoint) * 10_000 : Infinity;
    if (policy.whitelist.size > 0 && !policy.whitelist.has(symbol)) reasons.push('NOT_WHITELISTED');
    if (policy.blacklist.has(symbol)) reasons.push('BLACKLISTED');
    if (!asset.tradable || asset.status !== 'active') reasons.push('NOT_TRADABLE');
    if (blocked) reasons.push('SYMBOL_BLOCKED');
    if (halted) reasons.push('SYMBOL_HALTED');
    if (metrics.price < policy.minimumPrice || metrics.price > policy.maximumPrice) {
      reasons.push('PRICE_FILTER');
    }
    if (metrics.averageVolume < policy.minimumAverageVolume) reasons.push('VOLUME_FILTER');
    if (metrics.dollarVolume < policy.minimumDollarVolume) reasons.push('DOLLAR_VOLUME_FILTER');
    if (!Number.isFinite(spreadBps) || spreadBps > policy.maximumSpreadBps)
      reasons.push('SPREAD_FILTER');
    return Object.freeze({
      accepted: reasons.length === 0,
      spreadBps,
      reasons: Object.freeze(reasons),
    });
  }
}
