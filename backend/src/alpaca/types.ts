import { z } from 'zod';

const decimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const timestamp = z.iso.datetime({ offset: true });

export const alpacaAccountSchema = z.looseObject({
  id: z.string(),
  account_number: z.string(),
  status: z.string(),
  currency: z.string(),
  cash: decimalString,
  portfolio_value: decimalString,
  equity: decimalString,
  last_equity: decimalString,
  buying_power: decimalString,
  regt_buying_power: decimalString.optional(),
  daytrading_buying_power: decimalString.optional(),
  effective_buying_power: decimalString.optional(),
  multiplier: z.string(),
  pattern_day_trader: z.boolean(),
  daytrade_count: z.number().int().nonnegative(),
  trading_blocked: z.boolean(),
  transfers_blocked: z.boolean(),
  account_blocked: z.boolean(),
  trade_suspended_by_user: z.boolean(),
  shorting_enabled: z.boolean(),
  crypto_status: z.string().optional(),
  created_at: timestamp,
});
export type AlpacaAccount = z.infer<typeof alpacaAccountSchema>;

export const alpacaClockSchema = z.looseObject({
  timestamp,
  is_open: z.boolean(),
  next_open: timestamp,
  next_close: timestamp,
});
export type AlpacaClock = z.infer<typeof alpacaClockSchema>;

export const alpacaCalendarDaySchema = z.looseObject({
  date: z.iso.date(),
  open: z.string(),
  close: z.string(),
  session_open: z.string().optional(),
  session_close: z.string().optional(),
});
export type AlpacaCalendarDay = z.infer<typeof alpacaCalendarDaySchema>;

export const alpacaAssetSchema = z.looseObject({
  id: z.string(),
  asset_class: z.string(),
  exchange: z.string(),
  symbol: z.string(),
  name: z.string(),
  status: z.string(),
  tradable: z.boolean(),
  marginable: z.boolean(),
  maintenance_margin_requirement: z.number().nonnegative().optional(),
  shortable: z.boolean(),
  easy_to_borrow: z.boolean(),
  fractionable: z.boolean(),
  attributes: z.array(z.string()).optional().default([]),
});
export type AlpacaAsset = z.infer<typeof alpacaAssetSchema>;

export const alpacaOrderSchema = z.looseObject({
  id: z.string(),
  client_order_id: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
  submitted_at: timestamp.optional().nullable(),
  filled_at: timestamp.optional().nullable(),
  expired_at: timestamp.optional().nullable(),
  canceled_at: timestamp.optional().nullable(),
  failed_at: timestamp.optional().nullable(),
  replaced_at: timestamp.optional().nullable(),
  replaced_by: z.string().optional().nullable(),
  replaces: z.string().optional().nullable(),
  asset_id: z.string(),
  symbol: z.string(),
  asset_class: z.string(),
  qty: decimalString.optional().nullable(),
  notional: decimalString.optional().nullable(),
  filled_qty: decimalString,
  filled_avg_price: decimalString.optional().nullable(),
  order_class: z.string(),
  order_type: z.string(),
  type: z.string(),
  side: z.string(),
  time_in_force: z.string(),
  limit_price: decimalString.optional().nullable(),
  stop_price: decimalString.optional().nullable(),
  status: z.string(),
  extended_hours: z.boolean(),
  legs: z.array(z.unknown()).optional().nullable(),
});
export type AlpacaOrder = z.infer<typeof alpacaOrderSchema>;

export const alpacaPositionSchema = z.looseObject({
  asset_id: z.string(),
  symbol: z.string(),
  exchange: z.string(),
  asset_class: z.string(),
  avg_entry_price: decimalString,
  qty: decimalString,
  side: z.string(),
  market_value: decimalString,
  cost_basis: decimalString,
  unrealized_pl: decimalString,
  unrealized_plpc: decimalString,
  current_price: decimalString,
  lastday_price: decimalString,
  change_today: decimalString,
});
export type AlpacaPosition = z.infer<typeof alpacaPositionSchema>;

export const alpacaActivitySchema = z.looseObject({
  id: z.string(),
  activity_type: z.string(),
  transaction_time: timestamp.optional(),
  date: z.iso.date().optional(),
  symbol: z.string().optional(),
  qty: decimalString.optional(),
  price: decimalString.optional(),
  order_id: z.string().optional(),
  side: z.string().optional(),
  net_amount: decimalString.optional(),
});
export type AlpacaActivity = z.infer<typeof alpacaActivitySchema>;

export interface AlpacaOrderRequest {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
  readonly time_in_force: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
  readonly client_order_id: string;
  readonly qty?: string;
  readonly notional?: string;
  readonly limit_price?: string;
  readonly stop_price?: string;
  readonly trail_price?: string;
  readonly trail_percent?: string;
  readonly extended_hours?: boolean;
  readonly order_class?: 'simple' | 'bracket' | 'oco' | 'oto';
  readonly take_profit?: { readonly limit_price: string };
  readonly stop_loss?: { readonly stop_price: string; readonly limit_price?: string };
}

export interface ExternalActivityFinding {
  readonly kind: 'EXTERNAL_ORDER';
  readonly brokerOrderId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly status: string;
}
