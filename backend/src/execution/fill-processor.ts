import { Decimal } from 'decimal.js';
import type { AlpacaActivity } from '../alpaca/types.js';
import type { ExecutionFill, OrderAggregate } from './order-state-machine.js';

export interface FillProcessingEffects {
  readonly updatePosition: (fill: ExecutionFill) => Promise<void>;
  readonly updateExposure: (fill: ExecutionFill) => Promise<void>;
  readonly updateRisk: (fill: ExecutionFill) => Promise<void>;
  readonly updatePnlAndTaxLots: (fill: ExecutionFill) => Promise<void>;
}

export interface FillProcessorDependencies {
  readonly findOrderByBrokerId: (brokerOrderId: string) => Promise<OrderAggregate | undefined>;
  readonly hasFill: (fillId: string) => Promise<boolean>;
  readonly applyAtomically: (fill: ExecutionFill, effects: FillProcessingEffects) => Promise<void>;
  readonly effects: FillProcessingEffects;
  readonly onUnexpectedFill: (activity: AlpacaActivity) => Promise<void>;
}

export class FillProcessor {
  public constructor(private readonly dependencies: FillProcessorDependencies) {}

  public async process(activity: AlpacaActivity): Promise<ExecutionFill | undefined> {
    if (activity.activity_type !== 'FILL') return undefined;
    if (await this.dependencies.hasFill(activity.id)) return undefined;
    if (
      activity.order_id === undefined ||
      activity.symbol === undefined ||
      activity.side === undefined ||
      activity.qty === undefined ||
      activity.price === undefined ||
      activity.transaction_time === undefined
    )
      throw new Error('Incomplete broker fill activity');
    const order = await this.dependencies.findOrderByBrokerId(activity.order_id);
    if (order === undefined) {
      await this.dependencies.onUnexpectedFill(activity);
      return undefined;
    }
    const side = activity.side.toLowerCase();
    if (side !== 'buy' && side !== 'sell') throw new Error('Unsupported fill side');
    const fill: ExecutionFill = {
      id: activity.id,
      orderId: order.id,
      tradeIntentId: order.tradeIntentId,
      symbol: activity.symbol,
      side,
      quantity: new Decimal(activity.qty),
      price: new Decimal(activity.price),
      occurredAt: new Date(activity.transaction_time),
      unexpected: false,
    };
    order.applyFill(fill);
    await this.dependencies.applyAtomically(fill, this.dependencies.effects);
    return fill;
  }
}
