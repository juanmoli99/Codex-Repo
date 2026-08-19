import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { alpacaActivitySchema } from '../alpaca/types.js';
import { FillProcessor, type FillProcessingEffects } from './fill-processor.js';
import { OrderAggregate, type ExecutionFill } from './order-state-machine.js';

describe('FillProcessor', () => {
  it('applies one broker fill through the atomic position/exposure/risk/P&L hook', async () => {
    const order = new OrderAggregate('order', 'intent', 'client', 'AAPL', 'buy', new Decimal(10));
    const at = new Date('2026-08-18T14:00:00Z');
    order.transition('VALIDATING', 'test', at);
    order.transition('APPROVED', 'test', at);
    order.transition('SUBMITTING', 'test', at);
    order.transition('SUBMITTED', 'test', at);
    const effects = {
      updatePosition: vi.fn(async () => undefined),
      updateExposure: vi.fn(async () => undefined),
      updateRisk: vi.fn(async () => undefined),
      updatePnlAndTaxLots: vi.fn(async () => undefined),
    };
    const applyAtomically = vi.fn(
      async (fill: ExecutionFill, operations: FillProcessingEffects) => {
        await operations.updatePosition(fill);
        await operations.updateExposure(fill);
        await operations.updateRisk(fill);
        await operations.updatePnlAndTaxLots(fill);
      },
    );
    const processor = new FillProcessor({
      findOrderByBrokerId: async () => order,
      hasFill: async () => false,
      applyAtomically,
      effects,
      onUnexpectedFill: async () => undefined,
    });
    const activity = alpacaActivitySchema.parse({
      id: 'fill',
      activity_type: 'FILL',
      transaction_time: '2026-08-18T14:00:01Z',
      symbol: 'AAPL',
      qty: '4',
      price: '101',
      order_id: 'broker-order',
      side: 'buy',
    });
    expect((await processor.process(activity))?.quantity.toFixed()).toBe('4');
    expect(order.state).toBe('PARTIALLY_FILLED');
    expect(applyAtomically).toHaveBeenCalledOnce();
    expect(effects.updatePnlAndTaxLots).toHaveBeenCalledOnce();
  });
});
