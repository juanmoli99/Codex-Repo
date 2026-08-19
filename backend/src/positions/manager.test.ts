import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { evaluatePositionExit, increasePosition, updatePositionProtection } from './manager.js';
import type { ManagedPosition } from './manager.js';

function position(overrides: Partial<ManagedPosition> = {}): ManagedPosition {
  return {
    id: 'p',
    symbol: 'AAPL',
    strategyId: 'trend',
    strategyVersion: '1',
    openedAt: new Date('2026-08-18T13:00:00Z'),
    averageEntryPrice: new Decimal(100),
    quantity: new Decimal(10),
    remainingQuantity: new Decimal(10),
    stopLossPrice: new Decimal(95),
    takeProfitPrice: new Decimal(115),
    trailingDistance: new Decimal(5),
    breakEvenTriggerPrice: new Decimal(108),
    highWaterPrice: new Decimal(110),
    allowIncrease: false,
    ...overrides,
  };
}

describe('position management', () => {
  it('moves protection to break-even and emits one full trailing exit', () => {
    const protectedPosition = updatePositionProtection(position(), 109);
    expect(protectedPosition.stopLossPrice?.toFixed()).toBe('100');
    expect(
      evaluatePositionExit(protectedPosition, {
        price: 104,
        now: new Date('2026-08-18T14:00:00Z'),
        strategyExit: false,
        riskExit: false,
        emergencyExit: false,
      })?.reason,
    ).toBe('TRAILING_STOP');
    expect(
      evaluatePositionExit(
        { ...protectedPosition, pendingExitIntentId: 'exit' },
        {
          price: 90,
          now: new Date('2026-08-18T14:00:00Z'),
          strategyExit: true,
          riskExit: true,
          emergencyExit: true,
        },
      ),
    ).toBeUndefined();
  });

  it('rejects pyramiding unless explicitly enabled', () => {
    expect(() => increasePosition(position(), 1, 105)).toThrow('not explicitly enabled');
  });
});
