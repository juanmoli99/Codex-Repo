import { Decimal } from 'decimal.js';
import type { AlpacaAccount, AlpacaOrder, AlpacaPosition } from '../alpaca/types.js';

export interface NormalizedPosition {
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly quantity: Decimal;
  readonly averageEntryPrice: Decimal;
  readonly marketPrice: Decimal;
  readonly marketValue: Decimal;
  readonly costBasis: Decimal;
  readonly unrealizedPnl: Decimal;
  readonly unrealizedPnlPercent: Decimal;
}

export interface PortfolioExposure {
  readonly symbol: string;
  readonly positionNotional: Decimal;
  readonly pendingOrderNotional: Decimal;
  readonly totalNotional: Decimal;
  readonly equityPercent: Decimal;
}

export interface PortfolioState {
  readonly capturedAt: Date;
  readonly cash: Decimal;
  readonly equity: Decimal;
  readonly buyingPower: Decimal;
  readonly portfolioValue: Decimal;
  readonly positions: readonly NormalizedPosition[];
  readonly exposures: readonly PortfolioExposure[];
  readonly grossExposure: Decimal;
  readonly netExposure: Decimal;
  readonly longExposure: Decimal;
  readonly shortExposure: Decimal;
  readonly concentrationPercent: Decimal;
  readonly realizedPnl: Decimal;
  readonly unexpectedPositions: readonly string[];
  readonly orphanedPositionBindings: readonly string[];
}

function money(value: string | number | null | undefined): Decimal {
  return new Decimal(value ?? 0);
}

function isOpen(order: AlpacaOrder): boolean {
  return !['filled', 'canceled', 'expired', 'rejected', 'replaced'].includes(order.status);
}

function orderRemaining(order: AlpacaOrder): Decimal {
  return Decimal.max(0, money(order.qty).minus(money(order.filled_qty)));
}

export function buildPortfolioState(input: {
  account: AlpacaAccount;
  positions: readonly AlpacaPosition[];
  orders: readonly AlpacaOrder[];
  latestPrices: Readonly<Record<string, string>>;
  realizedPnl: string;
  expectedPositionSymbols: ReadonlySet<string>;
  capturedAt: Date;
}): PortfolioState {
  const equity = money(input.account.equity);
  const positions = input.positions.map<NormalizedPosition>((position) => {
    const quantity = money(position.qty).abs();
    const averageEntryPrice = money(position.avg_entry_price);
    const marketPrice = money(position.current_price);
    const signedMarketValue = money(position.market_value);
    return {
      symbol: position.symbol,
      side: position.side === 'short' ? 'SHORT' : 'LONG',
      quantity,
      averageEntryPrice,
      marketPrice,
      marketValue: signedMarketValue,
      costBasis: money(position.cost_basis),
      unrealizedPnl: money(position.unrealized_pl),
      unrealizedPnlPercent: money(position.unrealized_plpc).mul(100),
    };
  });

  const positionBySymbol = new Map(positions.map((position) => [position.symbol, position]));
  const pending = new Map<string, Decimal>();
  for (const order of input.orders.filter(isOpen)) {
    const referencePrice = money(
      order.limit_price ?? order.stop_price ?? input.latestPrices[order.symbol],
    );
    const residual = orderRemaining(order).mul(referencePrice);
    const signed = order.side === 'sell' ? residual.negated() : residual;
    pending.set(order.symbol, (pending.get(order.symbol) ?? new Decimal(0)).plus(signed));
  }

  const symbols = new Set([...positionBySymbol.keys(), ...pending.keys()]);
  const exposures = [...symbols]
    .map<PortfolioExposure>((symbol) => {
      const positionNotional = positionBySymbol.get(symbol)?.marketValue ?? new Decimal(0);
      const pendingOrderNotional = pending.get(symbol) ?? new Decimal(0);
      const totalNotional = positionNotional.plus(pendingOrderNotional);
      return {
        symbol,
        positionNotional,
        pendingOrderNotional,
        totalNotional,
        equityPercent: equity.isZero() ? new Decimal(0) : totalNotional.abs().div(equity).mul(100),
      };
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const longExposure = exposures.reduce(
    (sum, item) => sum.plus(Decimal.max(0, item.totalNotional)),
    new Decimal(0),
  );
  const shortExposure = exposures.reduce(
    (sum, item) => sum.plus(Decimal.min(0, item.totalNotional).abs()),
    new Decimal(0),
  );
  const grossExposure = longExposure.plus(shortExposure);
  const netExposure = longExposure.minus(shortExposure);
  const concentrationPercent = equity.isZero()
    ? new Decimal(0)
    : Decimal.max(0, ...exposures.map((exposure) => exposure.totalNotional.abs()))
        .div(equity)
        .mul(100);
  const actualSymbols = new Set(positions.map((position) => position.symbol));

  return {
    capturedAt: new Date(input.capturedAt),
    cash: money(input.account.cash),
    equity,
    buyingPower: money(input.account.buying_power),
    portfolioValue: money(input.account.portfolio_value),
    positions,
    exposures,
    grossExposure,
    netExposure,
    longExposure,
    shortExposure,
    concentrationPercent,
    realizedPnl: money(input.realizedPnl),
    unexpectedPositions: [...actualSymbols]
      .filter((symbol) => !input.expectedPositionSymbols.has(symbol))
      .sort(),
    orphanedPositionBindings: [...input.expectedPositionSymbols]
      .filter((symbol) => !actualSymbols.has(symbol))
      .sort(),
  };
}
