import { describe, expect, it, vi } from 'vitest';
import { alpacaAccountSchema, alpacaOrderSchema, alpacaPositionSchema } from '../alpaca/types.js';
import { ReconciliationService } from './service.js';

function brokerOrder(id: string, clientOrderId: string, status: string) {
  return alpacaOrderSchema.parse({
    id,
    client_order_id: clientOrderId,
    created_at: '2026-08-18T14:00:00Z',
    updated_at: '2026-08-18T14:00:00Z',
    asset_id: 'asset',
    symbol: 'AAPL',
    asset_class: 'us_equity',
    qty: '10',
    filled_qty: status === 'filled' ? '10' : '0',
    order_class: 'simple',
    order_type: 'market',
    type: 'market',
    side: 'buy',
    time_in_force: 'day',
    status,
    extended_hours: false,
  });
}

describe('ReconciliationService', () => {
  it('auto-corrects only safe terminal state while blocking an external order', async () => {
    const apply = vi.fn(async () => undefined);
    const block = vi.fn(async () => undefined);
    const time = new Date('2026-08-18T14:00:00Z');
    const service = new ReconciliationService({
      applySafeOrderStateCorrection: apply,
      persist: async () => undefined,
      blockSafety: block,
      now: () => time,
      idFactory: () => 'reconciliation',
    });
    const account = alpacaAccountSchema.parse({
      id: 'account',
      account_number: '1',
      status: 'ACTIVE',
      currency: 'USD',
      cash: '5000',
      portfolio_value: '10000',
      equity: '10000',
      last_equity: '10000',
      buying_power: '10000',
      multiplier: '2',
      pattern_day_trader: false,
      daytrade_count: 0,
      trading_blocked: false,
      transfers_blocked: false,
      account_blocked: false,
      trade_suspended_by_user: false,
      shorting_enabled: false,
      created_at: '2026-01-01T00:00:00Z',
    });
    const position = alpacaPositionSchema.parse({
      asset_id: 'asset',
      symbol: 'AAPL',
      exchange: 'NASDAQ',
      asset_class: 'us_equity',
      avg_entry_price: '100',
      qty: '10',
      side: 'long',
      market_value: '1000',
      cost_basis: '1000',
      unrealized_pl: '0',
      unrealized_plpc: '0',
      current_price: '100',
      lastday_price: '100',
      change_today: '0',
    });
    const result = await service.reconcile({
      trigger: 'SCHEDULED',
      localOrders: [
        {
          id: 'local',
          brokerOrderId: 'broker',
          clientOrderId: 'owned',
          symbol: 'AAPL',
          state: 'ACCEPTED',
          requestedQuantity: '10',
          filledQuantity: '0',
        },
      ],
      localPositions: [{ symbol: 'AAPL', quantity: '10', averageEntryPrice: '100' }],
      localFills: [],
      localAccount: { cash: '5000', equity: '10000', buyingPower: '10000' },
      brokerOrders: [
        brokerOrder('broker', 'owned', 'filled'),
        brokerOrder('external', 'manual', 'new'),
      ],
      brokerPositions: [position],
      brokerFills: [],
      brokerAccount: account,
      moneyTolerance: '0.01',
      quantityTolerance: '0.000001',
    });
    expect(result.safeCorrectionsApplied).toBe(1);
    expect(result.blocked).toBe(true);
    expect(apply).toHaveBeenCalledWith('local', 'FILLED');
    expect(block).toHaveBeenCalledWith(result);
  });
});
