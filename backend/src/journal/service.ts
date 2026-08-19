import { randomUUID } from 'node:crypto';

export type JournalEventType =
  | 'SIGNAL'
  | 'CANDIDATE'
  | 'RISK_DECISION'
  | 'POSITION_SIZING'
  | 'TRADE_INTENT'
  | 'ORDER'
  | 'BROKER_RESPONSE'
  | 'FILL'
  | 'POSITION'
  | 'EXIT'
  | 'PNL'
  | 'RECONCILIATION'
  | 'SAFETY'
  | 'MANUAL_ACTION';

export interface JournalEvent {
  readonly id: string;
  readonly correlationId: string;
  readonly tradeId?: string;
  readonly type: JournalEventType;
  readonly occurredAt: Date;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface JournalRepository {
  append(event: JournalEvent): Promise<void>;
  timeline(correlationId: string): Promise<readonly JournalEvent[]>;
}

export class TradingJournal {
  private readonly sequenceByCorrelation = new Map<string, number>();

  public constructor(
    private readonly repository: JournalRepository,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  public async record(input: Omit<JournalEvent, 'id' | 'sequence'>): Promise<JournalEvent> {
    const sequence = (this.sequenceByCorrelation.get(input.correlationId) ?? 0) + 1;
    const event: JournalEvent = {
      ...input,
      id: this.idFactory(),
      sequence,
      occurredAt: new Date(input.occurredAt),
      payload: Object.freeze({ ...input.payload }),
    };
    await this.repository.append(event);
    this.sequenceByCorrelation.set(input.correlationId, sequence);
    return event;
  }

  public async timeline(correlationId: string): Promise<readonly JournalEvent[]> {
    return [...(await this.repository.timeline(correlationId))].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }
}
