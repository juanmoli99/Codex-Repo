import { describe, expect, it } from 'vitest';
import { alpacaAccountSchema, alpacaOrderSchema, alpacaPositionSchema } from '../alpaca/types.js';
import { buildPortfolioState } from './service.js';

describe('buildPortfolioState', () => {
  it('consolidates positions, partial orders, exposure, and reconciliation anomalies', () => {
    const account = alpacaAccountSchema.parse({
      id: 'a',
      account_number: '1',
      status: 'ACTIVE',
      currency: 'USD',
      cash: '5000',
      portfolio_value: '10000',
      equity: '10000',
      last_equity: '9900',
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
      avg_entry_price: '90',
      qty: '10',
      side: 'long',
      market_value: '1000',
      cost_basis: '900',
      unrealized_pl: '100',
      unrealized_plpc: '0.111111',
      current_price: '100',
      lastday_price: '99',
      change_today: '0.01',
    });
    const order = alpacaOrderSchema.parse({
      id: 'o',
      client_order_id: 'managed-o',
      created_at: '2026-08-18T14:00:00Z',
      updated_at: '2026-08-18T14:00:00Z',
      asset_id: 'asset',
      symbol: 'AAPL',
      asset_class: 'us_equity',
      qty: '5',
      filled_qty: '2',
      order_class: 'simple',
      order_type: 'limit',
      type: 'limit',
      side: 'buy',
      time_in_force: 'day',
      limit_price: '100',
      status: 'partially_filled',
      extended_hours: false,
    });
    const state = buildPortfolioState({
      account,
      positions: [position],
      orders: [order],
      latestPrices: {},
      realizedPnl: '25',
      expectedPositionSymbols: new Set(['MSFT']),
      capturedAt: new Date('2026-08-18T14:01:00Z'),
    });
    expect(state.exposures[0]?.totalNotional.toFixed()).toBe('1300');
    expect(state.concentrationPercent.toFixed()).toBe('13');
    expect(state.unexpectedPositions).toEqual(['AAPL']);
    expect(state.orphanedPositionBindings).toEqual(['MSFT']);
  });
});
