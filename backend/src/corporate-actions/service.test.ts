import { describe, expect, it } from 'vitest';

import { CorporateActionService } from './service.js';

describe('CorporateActionService', () => {
  it('prepares a split adjustment but still requires broker reconciliation', () => {
    const plan = new CorporateActionService().plan(
      {
        id: 'split-1',
        type: 'FORWARD_SPLIT',
        status: 'EFFECTIVE',
        symbol: 'ABC',
        effectiveAt: new Date('2026-08-18T00:00:00Z'),
        quantityRatio: '4',
        raw: {},
      },
      [{ id: 'position-1', symbol: 'ABC', quantity: '10', costBasis: '1000' }],
      [{ id: 'order-1', symbol: 'ABC', status: 'accepted' }],
    );
    expect(plan.positionAdjustments[0]?.after).toMatchObject({ quantity: '40', costBasis: '1000' });
    expect(plan.cancelOrReviewOrderIds).toEqual(['order-1']);
    expect(plan.requiresBrokerReconciliation).toBe(true);
  });

  it('never auto-applies an ambiguous merger', () => {
    const plan = new CorporateActionService().plan(
      {
        id: 'merger-1',
        type: 'STOCK_AND_CASH_MERGER',
        status: 'EFFECTIVE',
        symbol: 'ABC',
        effectiveAt: new Date(),
        raw: {},
      },
      [],
      [],
    );
    expect(plan.automaticallySafe).toBe(false);
    expect(plan.blockNewEntries).toBe(true);
  });
});
