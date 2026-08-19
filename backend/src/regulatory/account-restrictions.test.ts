import { describe, expect, it } from 'vitest';

import { alpacaAccountSchema, alpacaAssetSchema } from '../alpaca/types.js';
import { AccountRestrictionGuard } from './account-restrictions.js';

const account = alpacaAccountSchema.parse({
  id: 'account',
  account_number: 'PA123',
  status: 'ACTIVE',
  currency: 'USD',
  cash: '10000',
  portfolio_value: '10000',
  equity: '10000',
  last_equity: '10000',
  buying_power: '10000',
  regt_buying_power: '10000',
  daytrading_buying_power: '0',
  multiplier: '2',
  pattern_day_trader: true,
  daytrade_count: 4,
  trading_blocked: false,
  transfers_blocked: false,
  account_blocked: false,
  trade_suspended_by_user: false,
  shorting_enabled: true,
  created_at: '2026-08-18T00:00:00Z',
});
const asset = alpacaAssetSchema.parse({
  id: 'asset',
  asset_class: 'us_equity',
  exchange: 'ARCA',
  symbol: 'SPY',
  name: 'SPDR S&P 500 ETF',
  status: 'active',
  tradable: true,
  marginable: true,
  shortable: true,
  easy_to_borrow: true,
  fractionable: true,
});

describe('AccountRestrictionGuard', () => {
  it('blocks conservatively when broker PDT buying power is zero', () => {
    const decision = new AccountRestrictionGuard().evaluate(
      account,
      asset,
      {
        side: 'buy',
        notional: '100',
        wouldOpenOrIncrease: true,
        wouldDayTrade: true,
        isShortSale: false,
      },
      { buyingPower: '10000', cash: '10000', equity: '10000' },
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('REGULATORY_BUYING_POWER_EXCEEDED');
    expect(decision.reasons).toContain('BROKER_PDT_RESTRICTION');
  });

  it('blocks any local/broker buying-power mismatch', () => {
    const decision = new AccountRestrictionGuard().evaluate(
      { ...account, pattern_day_trader: false, daytrading_buying_power: '10000' },
      asset,
      {
        side: 'buy',
        notional: '100',
        wouldOpenOrIncrease: true,
        wouldDayTrade: false,
        isShortSale: false,
      },
      { buyingPower: '9999', cash: '10000', equity: '10000' },
    );
    expect(decision.reasons).toContain('LOCAL_BROKER_BUYING_POWER_MISMATCH');
  });
});
