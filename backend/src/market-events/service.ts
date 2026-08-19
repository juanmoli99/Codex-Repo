export type MarketEventType = 'EARNINGS' | 'DIVIDEND' | 'ECONOMIC' | 'KNOWN_EVENT';
export type EventTiming = 'PRE_MARKET' | 'POST_MARKET' | 'DURING_MARKET' | 'UNKNOWN';

export interface MarketEvent {
  readonly id: string;
  readonly symbol?: string;
  readonly type: MarketEventType;
  readonly scheduledAt: Date;
  readonly timing: EventTiming;
  readonly source: string;
  readonly sourceVersion: string;
}

export interface EventPolicy {
  readonly id: string;
  readonly strategyId: string;
  readonly eventType: MarketEventType;
  readonly blackoutBeforeMs: number;
  readonly blackoutAfterMs: number;
  readonly positionSizeMultiplier: number;
  readonly prohibitOvernight: boolean;
  readonly failClosedWhenCalendarUnavailable: boolean;
}

export interface AppliedEventPolicy {
  readonly policyId: string;
  readonly strategyId: string;
  readonly symbol: string;
  readonly eventId?: string;
  readonly evaluatedAt: Date;
  readonly timeToEventMs?: number;
  readonly entryAllowed: boolean;
  readonly positionSizeMultiplier: number;
  readonly overnightAllowed: boolean;
  readonly reasons: readonly string[];
}

export interface MarketEventProvider {
  readonly id: string;
  list(symbols: readonly string[], from: Date, to: Date): Promise<readonly MarketEvent[]>;
}

export class MarketEventService {
  private calendarAvailable = false;
  private readonly events = new Map<string, MarketEvent>();

  public constructor(private readonly provider: MarketEventProvider) {}

  public async refresh(symbols: readonly string[], from: Date, to: Date): Promise<number> {
    try {
      const events = await this.provider.list(symbols, from, to);
      for (const event of events) this.events.set(event.id, Object.freeze(event));
      this.calendarAvailable = true;
      return events.length;
    } catch (error) {
      this.calendarAvailable = false;
      throw error;
    }
  }

  public next(symbol: string, type: MarketEventType, after = new Date()): MarketEvent | undefined {
    return [...this.events.values()]
      .filter(
        (event) =>
          event.symbol === symbol &&
          event.type === type &&
          event.scheduledAt.getTime() >= after.getTime(),
      )
      .sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime())[0];
  }

  public evaluate(
    symbol: string,
    policy: EventPolicy,
    evaluatedAt = new Date(),
  ): AppliedEventPolicy {
    const reasons: string[] = [];
    if (!this.calendarAvailable && policy.failClosedWhenCalendarUnavailable) {
      reasons.push('EVENT_CALENDAR_UNAVAILABLE');
      return Object.freeze({
        policyId: policy.id,
        strategyId: policy.strategyId,
        symbol,
        evaluatedAt,
        entryAllowed: false,
        positionSizeMultiplier: 0,
        overnightAllowed: false,
        reasons: Object.freeze(reasons),
      });
    }

    const relevant = [...this.events.values()]
      .filter((event) => event.symbol === symbol && event.type === policy.eventType)
      .sort(
        (left, right) =>
          Math.abs(left.scheduledAt.getTime() - evaluatedAt.getTime()) -
          Math.abs(right.scheduledAt.getTime() - evaluatedAt.getTime()),
      )[0];
    if (!relevant) {
      return Object.freeze({
        policyId: policy.id,
        strategyId: policy.strategyId,
        symbol,
        evaluatedAt,
        entryAllowed: true,
        positionSizeMultiplier: 1,
        overnightAllowed: true,
        reasons: Object.freeze(reasons),
      });
    }
    const timeToEventMs = relevant.scheduledAt.getTime() - evaluatedAt.getTime();
    const inBlackout =
      timeToEventMs >= 0
        ? timeToEventMs <= policy.blackoutBeforeMs
        : Math.abs(timeToEventMs) <= policy.blackoutAfterMs;
    if (inBlackout) reasons.push('EVENT_BLACKOUT_ACTIVE');
    return Object.freeze({
      policyId: policy.id,
      strategyId: policy.strategyId,
      symbol,
      eventId: relevant.id,
      evaluatedAt,
      timeToEventMs,
      entryAllowed: !inBlackout,
      positionSizeMultiplier: inBlackout ? policy.positionSizeMultiplier : 1,
      overnightAllowed: !(inBlackout && policy.prohibitOvernight),
      reasons: Object.freeze(reasons),
    });
  }
}

export class InMemoryMarketEventProvider implements MarketEventProvider {
  public readonly id = 'in-memory';

  public constructor(private readonly events: readonly MarketEvent[]) {}

  public list(symbols: readonly string[], from: Date, to: Date): Promise<readonly MarketEvent[]> {
    const accepted = new Set(symbols);
    return Promise.resolve(
      this.events.filter(
        (event) =>
          (!event.symbol || accepted.has(event.symbol)) &&
          event.scheduledAt >= from &&
          event.scheduledAt <= to,
      ),
    );
  }
}
