import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { OrderAggregate } from './order-state-machine.js';
import { ProtectionGroup } from './protection-group.js';

describe('OrderAggregate', () => {
  it('enforces transitions and accumulates idempotent partial fills', () => {
    const order = new OrderAggregate('o', 'i', 'client', 'AAPL', 'buy', new Decimal(10));
    const at = new Date('2026-08-18T14:00:00Z');
    expect(() => order.transition('FILLED', 'invalid', at)).toThrow('Forbidden');
    order.transition('VALIDATING', 'validate', at);
    order.transition('APPROVED', 'risk', at);
    order.transition('SUBMITTING', 'submit', at);
    order.transition('SUBMITTED', 'broker', at);
    const fill = {
      id: 'f1',
      orderId: 'o',
      tradeIntentId: 'i',
      symbol: 'AAPL',
      side: 'buy' as const,
      quantity: new Decimal(4),
      price: new Decimal(100),
      occurredAt: at,
      unexpected: false,
    };
    expect(order.applyFill(fill)).toBe(true);
    expect(order.applyFill(fill)).toBe(false);
    expect(order.state).toBe('PARTIALLY_FILLED');
    order.applyFill({ ...fill, id: 'f2', quantity: new Decimal(6), price: new Decimal(103) });
    expect(order.state).toBe('FILLED');
    expect(order.filledQuantity.toFixed()).toBe('10');
    expect(order.averageFillPrice?.toFixed()).toBe('101.8');
  });
});

describe('ProtectionGroup', () => {
  it('activates children after parent fills and cancels/reconciles an OCO race', () => {
    const group = new ProtectionGroup('g', 'AAPL', 'p', [
      { id: 'parent', role: 'PARENT', state: 'ACTIVE', filledQuantity: '0' },
      { id: 'tp', role: 'TAKE_PROFIT', state: 'DORMANT', filledQuantity: '0' },
      { id: 'sl', role: 'STOP_LOSS', state: 'DORMANT', filledQuantity: '0' },
    ]);
    expect(group.update('parent', 'PARTIALLY_FILLED', '5')[0]?.type).toBe('ACTIVATE_CHILDREN');
    expect(group.update('tp', 'FILLED', '5').map((action) => action.type)).toEqual([
      'CANCEL_SIBLING',
      'RECONCILE',
    ]);
  });
});
