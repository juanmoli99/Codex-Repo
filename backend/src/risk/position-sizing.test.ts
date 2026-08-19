import { describe, expect, it } from 'vitest';
import { conservativePaperRiskConfiguration, createRiskConfigurationSnapshot } from './config.js';
import { sizePosition } from './position-sizing.js';

describe('sizePosition', () => {
  const snapshot = createRiskConfigurationSnapshot(
    conservativePaperRiskConfiguration,
    new Date('2026-08-18T00:00:00Z'),
  );

  it('uses stop risk and fractional precision with an explainable cap', () => {
    const result = sizePosition(
      {
        symbol: 'AAPL',
        equity: 10_000,
        cash: 5_000,
        buyingPower: 10_000,
        entryPrice: 100,
        stopPrice: 98,
        existingExposure: 0,
        pendingExposure: 0,
        minimumQuantity: 0.001,
        fractionable: true,
        quantityPrecision: 3,
        pricePrecision: 2,
      },
      snapshot,
    );
    expect(result.approved).toBe(true);
    expect(result.quantity.toFixed()).toBe('10');
    expect(result.notional.toFixed()).toBe('1000');
    expect(result.monetaryRisk.toFixed()).toBe('20');
    expect(result.bindingConstraint).toBe('MAXIMUM_CAPITAL_PERCENT');
  });

  it('rejects a zero stop distance', () => {
    const result = sizePosition(
      {
        symbol: 'AAPL',
        equity: 10_000,
        cash: 5_000,
        buyingPower: 10_000,
        entryPrice: 100,
        stopPrice: 100,
        existingExposure: 0,
        pendingExposure: 0,
        minimumQuantity: 1,
        fractionable: false,
        quantityPrecision: 0,
        pricePrecision: 2,
      },
      snapshot,
    );
    expect(result).toMatchObject({ approved: false, reasons: ['STOP_DISTANCE_NOT_POSITIVE'] });
  });
});
