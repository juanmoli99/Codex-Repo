import { describe, expect, it, vi } from 'vitest';

import { MarketDataCache } from '../market-data/cache.js';
import { AlpacaMarketDataClient } from '../market-data/client.js';
import { AlpacaTradingClient } from './trading-client.js';
import type { AlpacaHttpClient } from './http-client.js';

function contractHttp(payloads: Readonly<Record<string, unknown>>): AlpacaHttpClient {
  return {
    request: vi.fn(async (input: { path: string; schema: { parse(value: unknown): unknown } }) =>
      input.schema.parse(payloads[input.path]),
    ),
  } as unknown as AlpacaHttpClient;
}

describe('Alpaca response contracts', () => {
  it('accepts representative trading account, clock, order, position and activity payloads', async () => {
    const timestamp = '2026-08-18T14:00:00Z';
    const order = {
      id: 'order',
      client_order_id: 'client',
      created_at: timestamp,
      updated_at: timestamp,
      asset_id: 'asset',
      symbol: 'AAPL',
      asset_class: 'us_equity',
      qty: '1',
      filled_qty: '0',
      order_class: 'simple',
      order_type: 'market',
      type: 'market',
      side: 'buy',
      time_in_force: 'day',
      status: 'new',
      extended_hours: false,
    };
    const http = contractHttp({
      '/v2/account': {
        id: 'account',
        account_number: '1',
        status: 'ACTIVE',
        currency: 'USD',
        cash: '1000',
        portfolio_value: '1000',
        equity: '1000',
        last_equity: '1000',
        buying_power: '2000',
        multiplier: '2',
        pattern_day_trader: false,
        daytrade_count: 0,
        trading_blocked: false,
        transfers_blocked: false,
        account_blocked: false,
        trade_suspended_by_user: false,
        shorting_enabled: true,
        created_at: timestamp,
      },
      '/v2/clock': { timestamp, is_open: true, next_open: timestamp, next_close: timestamp },
      '/v2/orders': [order],
      '/v2/positions': [
        {
          asset_id: 'asset',
          symbol: 'AAPL',
          exchange: 'NASDAQ',
          asset_class: 'us_equity',
          avg_entry_price: '100',
          qty: '1',
          side: 'long',
          market_value: '100',
          cost_basis: '100',
          unrealized_pl: '0',
          unrealized_plpc: '0',
          current_price: '100',
          lastday_price: '99',
          change_today: '0.01',
        },
      ],
      '/v2/account/activities': [
        {
          id: 'fill',
          activity_type: 'FILL',
          transaction_time: timestamp,
          symbol: 'AAPL',
          qty: '1',
          price: '100',
          order_id: 'order',
          side: 'buy',
        },
      ],
    });
    const client = new AlpacaTradingClient(http);

    await expect(client.getAccount()).resolves.toMatchObject({ status: 'ACTIVE' });
    await expect(client.getClock()).resolves.toMatchObject({ is_open: true });
    await expect(client.listOrders('all')).resolves.toHaveLength(1);
    await expect(client.listPositions()).resolves.toHaveLength(1);
    await expect(client.listActivities(['FILL'])).resolves.toHaveLength(1);
  });

  it('normalizes market-data wire fields and rejects malformed numeric strings', async () => {
    const timestamp = '2026-08-18T14:00:00Z';
    const market = new AlpacaMarketDataClient(
      contractHttp({
        '/v2/stocks/bars/latest': {
          bars: { AAPL: { t: timestamp, o: 99, h: 101, l: 98, c: 100, v: 1000, n: 20 } },
        },
        '/v2/stocks/quotes/latest': {
          quotes: { AAPL: { t: timestamp, bp: 99.99, bs: 10, ap: 100.01, as: 12 } },
        },
        '/v2/stocks/trades/latest': {
          trades: { AAPL: { t: timestamp, p: 100, s: 2, i: 42 } },
        },
      }),
      new MarketDataCache(),
    );
    await expect(market.getLatestBars(['aapl'])).resolves.toMatchObject([
      { symbol: 'AAPL', close: 100, tradeCount: 20 },
    ]);
    await expect(market.getLatestQuotes(['AAPL'])).resolves.toMatchObject([
      { symbol: 'AAPL', bidPrice: 99.99, askPrice: 100.01 },
    ]);
    await expect(market.getLatestTrades(['AAPL'])).resolves.toMatchObject([
      { symbol: 'AAPL', price: 100, id: '42' },
    ]);

    const malformed = new AlpacaTradingClient(
      contractHttp({ '/v2/account': { status: 'ACTIVE', cash: 'not-a-number' } }),
    );
    await expect(malformed.getAccount()).rejects.toBeDefined();
  });
});
