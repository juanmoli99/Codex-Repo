import { Decimal } from 'decimal.js';

export type OrderState =
  | 'CREATED'
  | 'VALIDATING'
  | 'APPROVED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_PENDING'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'REPLACED'
  | 'UNKNOWN';

const transitions: Readonly<Record<OrderState, readonly OrderState[]>> = {
  CREATED: ['VALIDATING'],
  VALIDATING: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUBMITTING', 'CANCELED'],
  SUBMITTING: ['SUBMITTED', 'REJECTED', 'UNKNOWN'],
  SUBMITTED: [
    'ACCEPTED',
    'PARTIALLY_FILLED',
    'FILLED',
    'REJECTED',
    'CANCELED',
    'EXPIRED',
    'UNKNOWN',
  ],
  ACCEPTED: [
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCEL_PENDING',
    'CANCELED',
    'EXPIRED',
    'REPLACED',
    'UNKNOWN',
  ],
  PARTIALLY_FILLED: [
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCEL_PENDING',
    'CANCELED',
    'EXPIRED',
    'REPLACED',
    'UNKNOWN',
  ],
  FILLED: [],
  CANCEL_PENDING: ['CANCELED', 'PARTIALLY_FILLED', 'FILLED', 'UNKNOWN'],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
  REPLACED: [],
  UNKNOWN: [
    'SUBMITTED',
    'ACCEPTED',
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCELED',
    'REJECTED',
    'EXPIRED',
    'REPLACED',
  ],
};

export interface OrderTransition {
  readonly sequence: number;
  readonly from: OrderState;
  readonly to: OrderState;
  readonly reason: string;
  readonly occurredAt: Date;
  readonly brokerStatus?: string;
}

export interface ExecutionFill {
  readonly id: string;
  readonly orderId: string;
  readonly tradeIntentId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: Decimal;
  readonly price: Decimal;
  readonly occurredAt: Date;
  readonly unexpected: boolean;
}

export class OrderAggregate {
  private stateValue: OrderState = 'CREATED';
  private readonly transitionHistory: OrderTransition[] = [];
  private readonly fillsById = new Map<string, ExecutionFill>();
  private filled = new Decimal(0);
  private fillNotional = new Decimal(0);

  public constructor(
    public readonly id: string,
    public readonly tradeIntentId: string,
    public readonly clientOrderId: string,
    public readonly symbol: string,
    public readonly side: 'buy' | 'sell',
    public readonly requestedQuantity: Decimal,
    public readonly parentOrderId?: string,
    public readonly originalOrderId?: string,
  ) {
    if (!requestedQuantity.gt(0)) throw new Error('Order quantity must be greater than zero');
  }

  public static rehydrate(input: {
    id: string;
    tradeIntentId: string;
    clientOrderId: string;
    symbol: string;
    side: 'buy' | 'sell';
    requestedQuantity: Decimal.Value;
    state: OrderState;
    transitions: readonly OrderTransition[];
    fills: readonly ExecutionFill[];
    parentOrderId?: string;
    originalOrderId?: string;
  }): OrderAggregate {
    const aggregate = new OrderAggregate(
      input.id,
      input.tradeIntentId,
      input.clientOrderId,
      input.symbol,
      input.side,
      new Decimal(input.requestedQuantity),
      input.parentOrderId,
      input.originalOrderId,
    );
    aggregate.stateValue = input.state;
    aggregate.transitionHistory.push(
      ...input.transitions.map((transition) => ({
        ...transition,
        occurredAt: new Date(transition.occurredAt),
      })),
    );
    for (const fill of input.fills) {
      aggregate.fillsById.set(fill.id, fill);
      aggregate.filled = aggregate.filled.plus(fill.quantity);
      aggregate.fillNotional = aggregate.fillNotional.plus(fill.quantity.mul(fill.price));
    }
    return aggregate;
  }

  public get state(): OrderState {
    return this.stateValue;
  }

  public get filledQuantity(): Decimal {
    return this.filled;
  }

  public get remainingQuantity(): Decimal {
    return Decimal.max(0, this.requestedQuantity.minus(this.filled));
  }

  public get averageFillPrice(): Decimal | null {
    return this.filled.gt(0) ? this.fillNotional.div(this.filled) : null;
  }

  public get history(): readonly OrderTransition[] {
    return [...this.transitionHistory];
  }

  public get fills(): readonly ExecutionFill[] {
    return [...this.fillsById.values()];
  }

  public transition(
    next: OrderState,
    reason: string,
    occurredAt: Date,
    brokerStatus?: string,
  ): OrderTransition {
    if (!transitions[this.stateValue].includes(next))
      throw new Error(`Forbidden order transition: ${this.stateValue} -> ${next}`);
    const event: OrderTransition = {
      sequence: this.transitionHistory.length + 1,
      from: this.stateValue,
      to: next,
      reason,
      occurredAt: new Date(occurredAt),
      ...(brokerStatus === undefined ? {} : { brokerStatus }),
    };
    this.stateValue = next;
    this.transitionHistory.push(event);
    return event;
  }

  public applyFill(fill: ExecutionFill): boolean {
    if (this.fillsById.has(fill.id)) return false;
    if (fill.orderId !== this.id) throw new Error('Fill belongs to a different order');
    if (!fill.quantity.gt(0) || !fill.price.gt(0)) throw new Error('Invalid fill');
    if (this.filled.plus(fill.quantity).gt(this.requestedQuantity))
      throw new Error('Fill exceeds requested quantity');
    if (
      !['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'UNKNOWN'].includes(
        this.state,
      )
    )
      throw new Error(`Order cannot receive a fill while ${this.state}`);
    this.fillsById.set(fill.id, fill);
    this.filled = this.filled.plus(fill.quantity);
    this.fillNotional = this.fillNotional.plus(fill.quantity.mul(fill.price));
    const target = this.remainingQuantity.isZero() ? 'FILLED' : 'PARTIALLY_FILLED';
    this.transition(target, `Fill ${fill.id} applied`, fill.occurredAt, target.toLowerCase());
    return true;
  }
}

export function brokerStatusToOrderState(status: string): OrderState {
  const normalized = status.toLowerCase();
  const mapping: Readonly<Record<string, OrderState>> = {
    new: 'ACCEPTED',
    accepted: 'ACCEPTED',
    pending_new: 'SUBMITTED',
    accepted_for_bidding: 'ACCEPTED',
    partially_filled: 'PARTIALLY_FILLED',
    filled: 'FILLED',
    pending_cancel: 'CANCEL_PENDING',
    canceled: 'CANCELED',
    rejected: 'REJECTED',
    expired: 'EXPIRED',
    replaced: 'REPLACED',
    pending_replace: 'ACCEPTED',
    stopped: 'CANCELED',
    suspended: 'UNKNOWN',
    calculated: 'UNKNOWN',
  };
  return mapping[normalized] ?? 'UNKNOWN';
}
