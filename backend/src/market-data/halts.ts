export interface TradingStatusMessage {
  readonly type: 'STATUS';
  readonly symbol: string;
  readonly statusCode: string;
  readonly statusMessage: string;
  readonly reasonCode: string;
  readonly reasonMessage: string;
  readonly timestamp: Date;
}

export interface LuldMessage {
  readonly type: 'LULD';
  readonly symbol: string;
  readonly limitUp: number;
  readonly limitDown: number;
  readonly indicator: string;
  readonly timestamp: Date;
}

export type SymbolTradingState = 'TRADING' | 'HALTED' | 'RESUME_COOLDOWN' | 'UNKNOWN';

export interface HaltSnapshot {
  readonly symbol: string;
  readonly state: SymbolTradingState;
  readonly reasonCode?: string;
  readonly reasonMessage?: string;
  readonly haltedAt?: Date;
  readonly resumedAt?: Date;
  readonly cooldownUntil?: Date;
  readonly luld?: {
    readonly limitUp: number;
    readonly limitDown: number;
    readonly indicator: string;
    readonly timestamp: Date;
  };
  readonly signalGeneration: number;
  readonly updatedAt: Date;
}

export interface HaltActionPlan {
  readonly cancelNewEntries: boolean;
  readonly holdExistingOrdersForReview: boolean;
  readonly markPositionAffected: boolean;
  readonly invalidateSignalsBefore: Date;
  readonly invalidateCachedPrices: boolean;
  readonly requireFullRevalidation: boolean;
}

const HALT_STATUS_CODES = new Set(['2', 'H', 'P']);
const RESUME_STATUS_CODES = new Set(['3', 'Q', 'T', 'R', 'R1', 'MWCQ']);

export class TradingHaltService {
  private readonly states = new Map<string, HaltSnapshot>();

  public constructor(
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  public initializeTrading(symbol: string): HaltSnapshot {
    const previous = this.states.get(symbol);
    if (previous?.state === 'HALTED' || previous?.state === 'RESUME_COOLDOWN') return previous;
    const snapshot: HaltSnapshot = Object.freeze({
      symbol,
      state: 'TRADING',
      signalGeneration: previous?.signalGeneration ?? 0,
      updatedAt: new Date(this.now()),
      ...(previous?.luld ? { luld: previous.luld } : {}),
    });
    this.states.set(symbol, snapshot);
    return snapshot;
  }

  public applyStatus(message: TradingStatusMessage): {
    readonly snapshot: HaltSnapshot;
    readonly plan: HaltActionPlan;
  } {
    const previous = this.states.get(message.symbol);
    const generation = previous?.signalGeneration ?? 0;
    let snapshot: HaltSnapshot;
    let plan: HaltActionPlan;

    if (HALT_STATUS_CODES.has(message.statusCode)) {
      snapshot = Object.freeze({
        symbol: message.symbol,
        state: 'HALTED',
        reasonCode: message.reasonCode,
        reasonMessage: message.reasonMessage,
        haltedAt: message.timestamp,
        signalGeneration: generation + 1,
        updatedAt: new Date(this.now()),
        ...(previous?.luld ? { luld: previous.luld } : {}),
      });
      plan = Object.freeze({
        cancelNewEntries: true,
        holdExistingOrdersForReview: true,
        markPositionAffected: true,
        invalidateSignalsBefore: message.timestamp,
        invalidateCachedPrices: true,
        requireFullRevalidation: true,
      });
    } else if (RESUME_STATUS_CODES.has(message.statusCode)) {
      const cooldownUntil = new Date(message.timestamp.getTime() + this.cooldownMs);
      snapshot = Object.freeze({
        symbol: message.symbol,
        state: 'RESUME_COOLDOWN',
        reasonCode: message.reasonCode,
        reasonMessage: message.reasonMessage,
        ...(previous?.haltedAt ? { haltedAt: previous.haltedAt } : {}),
        resumedAt: message.timestamp,
        cooldownUntil,
        signalGeneration: generation + 1,
        updatedAt: new Date(this.now()),
        ...(previous?.luld ? { luld: previous.luld } : {}),
      });
      plan = Object.freeze({
        cancelNewEntries: true,
        holdExistingOrdersForReview: true,
        markPositionAffected: true,
        invalidateSignalsBefore: message.timestamp,
        invalidateCachedPrices: true,
        requireFullRevalidation: true,
      });
    } else {
      snapshot = Object.freeze({
        symbol: message.symbol,
        state: previous?.state ?? 'UNKNOWN',
        reasonCode: message.reasonCode,
        reasonMessage: message.reasonMessage,
        signalGeneration: generation,
        updatedAt: new Date(this.now()),
        ...(previous?.haltedAt ? { haltedAt: previous.haltedAt } : {}),
        ...(previous?.resumedAt ? { resumedAt: previous.resumedAt } : {}),
        ...(previous?.cooldownUntil ? { cooldownUntil: previous.cooldownUntil } : {}),
        ...(previous?.luld ? { luld: previous.luld } : {}),
      });
      plan = Object.freeze({
        cancelNewEntries: snapshot.state !== 'TRADING',
        holdExistingOrdersForReview: false,
        markPositionAffected: snapshot.state === 'HALTED',
        invalidateSignalsBefore: message.timestamp,
        invalidateCachedPrices: snapshot.state === 'HALTED',
        requireFullRevalidation: snapshot.state !== 'TRADING',
      });
    }
    this.states.set(message.symbol, snapshot);
    return { snapshot, plan };
  }

  public applyLuld(message: LuldMessage): HaltSnapshot {
    const previous = this.states.get(message.symbol);
    const snapshot: HaltSnapshot = Object.freeze({
      symbol: message.symbol,
      state: previous?.state ?? 'UNKNOWN',
      signalGeneration: previous?.signalGeneration ?? 0,
      updatedAt: new Date(this.now()),
      ...(previous?.reasonCode ? { reasonCode: previous.reasonCode } : {}),
      ...(previous?.reasonMessage ? { reasonMessage: previous.reasonMessage } : {}),
      ...(previous?.haltedAt ? { haltedAt: previous.haltedAt } : {}),
      ...(previous?.resumedAt ? { resumedAt: previous.resumedAt } : {}),
      ...(previous?.cooldownUntil ? { cooldownUntil: previous.cooldownUntil } : {}),
      luld: {
        limitUp: message.limitUp,
        limitDown: message.limitDown,
        indicator: message.indicator,
        timestamp: message.timestamp,
      },
    });
    this.states.set(message.symbol, snapshot);
    return snapshot;
  }

  public confirmRevalidation(symbol: string): HaltSnapshot | undefined {
    const previous = this.states.get(symbol);
    if (
      previous?.state !== 'RESUME_COOLDOWN' ||
      !previous.cooldownUntil ||
      this.now() < previous.cooldownUntil.getTime()
    ) {
      return previous;
    }
    const snapshot: HaltSnapshot = Object.freeze({
      ...previous,
      state: 'TRADING',
      updatedAt: new Date(this.now()),
    });
    this.states.set(symbol, snapshot);
    return snapshot;
  }

  public canOpen(symbol: string): boolean {
    return this.states.get(symbol)?.state === 'TRADING';
  }

  public current(symbol: string): HaltSnapshot | undefined {
    return this.states.get(symbol);
  }
}

export function parseMarketStreamMessage(
  value: unknown,
): TradingStatusMessage | LuldMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (
    message.T === 's' &&
    typeof message.S === 'string' &&
    typeof message.sc === 'string' &&
    typeof message.sm === 'string' &&
    typeof message.rc === 'string' &&
    typeof message.rm === 'string' &&
    typeof message.t === 'string'
  ) {
    return {
      type: 'STATUS',
      symbol: message.S,
      statusCode: message.sc,
      statusMessage: message.sm,
      reasonCode: message.rc,
      reasonMessage: message.rm,
      timestamp: new Date(message.t),
    };
  }
  if (
    message.T === 'l' &&
    typeof message.S === 'string' &&
    typeof message.u === 'number' &&
    typeof message.d === 'number' &&
    typeof message.i === 'string' &&
    typeof message.t === 'string'
  ) {
    return {
      type: 'LULD',
      symbol: message.S,
      limitUp: message.u,
      limitDown: message.d,
      indicator: message.i,
      timestamp: new Date(message.t),
    };
  }
  return null;
}
