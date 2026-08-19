import { Decimal } from 'decimal.js';

export interface ClosedTrade {
  readonly id: string;
  readonly symbol: string;
  readonly strategyId: string;
  readonly openedAt: Date;
  readonly closedAt: Date;
  readonly realizedPnl: Decimal.Value;
}

export interface EquityPoint {
  readonly timestamp: Date;
  readonly equity: Decimal;
  readonly highWaterMark: Decimal;
  readonly drawdown: Decimal;
  readonly drawdownPercent: Decimal;
}

export interface PnlSummary {
  readonly realized: Decimal;
  readonly unrealized: Decimal;
  readonly total: Decimal;
  readonly daily: Decimal;
  readonly weekly: Decimal;
  readonly monthly: Decimal;
  readonly bySymbol: Readonly<Record<string, string>>;
  readonly byStrategy: Readonly<Record<string, string>>;
  readonly byTrade: Readonly<Record<string, string>>;
  readonly equityCurve: readonly EquityPoint[];
  readonly currentDrawdownPercent: Decimal;
  readonly maximumDrawdownPercent: Decimal;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function sumBy(
  trades: readonly ClosedTrade[],
  key: (trade: ClosedTrade) => string,
): Readonly<Record<string, string>> {
  const values = new Map<string, Decimal>();
  for (const trade of trades)
    values.set(key(trade), (values.get(key(trade)) ?? new Decimal(0)).plus(trade.realizedPnl));
  return Object.fromEntries([...values].map(([group, value]) => [group, value.toFixed()]));
}

export function calculatePnl(input: {
  initialEquity: Decimal.Value;
  currentUnrealizedPnl: Decimal.Value;
  trades: readonly ClosedTrade[];
  now: Date;
}): PnlSummary {
  const initialEquity = new Decimal(input.initialEquity);
  const ordered = [...input.trades].sort(
    (left, right) => left.closedAt.getTime() - right.closedAt.getTime(),
  );
  let equity = initialEquity;
  let highWaterMark = initialEquity;
  let maximumDrawdownPercent = new Decimal(0);
  const equityCurve = ordered.map<EquityPoint>((trade) => {
    equity = equity.plus(trade.realizedPnl);
    highWaterMark = Decimal.max(highWaterMark, equity);
    const drawdown = highWaterMark.minus(equity);
    const drawdownPercent = highWaterMark.isZero()
      ? new Decimal(0)
      : drawdown.div(highWaterMark).mul(100);
    maximumDrawdownPercent = Decimal.max(maximumDrawdownPercent, drawdownPercent);
    return {
      timestamp: new Date(trade.closedAt),
      equity,
      highWaterMark,
      drawdown,
      drawdownPercent,
    };
  });
  const realized = ordered.reduce((sum, trade) => sum.plus(trade.realizedPnl), new Decimal(0));
  const unrealized = new Decimal(input.currentUnrealizedPnl);
  const today = startOfUtcDay(input.now);
  const week = new Date(today);
  week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const month = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), 1));
  const period = (start: Date) =>
    ordered
      .filter((trade) => trade.closedAt >= start && trade.closedAt <= input.now)
      .reduce((sum, trade) => sum.plus(trade.realizedPnl), new Decimal(0));
  const currentDrawdownPercent = highWaterMark.isZero()
    ? new Decimal(0)
    : highWaterMark.minus(equity.plus(unrealized)).div(highWaterMark).mul(100);
  return {
    realized,
    unrealized,
    total: realized.plus(unrealized),
    daily: period(today),
    weekly: period(week),
    monthly: period(month),
    bySymbol: sumBy(ordered, (trade) => trade.symbol),
    byStrategy: sumBy(ordered, (trade) => trade.strategyId),
    byTrade: sumBy(ordered, (trade) => trade.id),
    equityCurve,
    currentDrawdownPercent,
    maximumDrawdownPercent,
  };
}

export interface RuntimeRiskAction {
  readonly type: 'NONE' | 'ONLY_CLOSE' | 'KILL_SWITCH';
  readonly reasons: readonly string[];
}

export function enforceRuntimeRisk(input: {
  dailyPnl: Decimal.Value;
  equity: Decimal.Value;
  drawdownPercent: Decimal.Value;
  portfolioRiskPercent: Decimal.Value;
  dailyLossLimitPercent: number;
  maximumDrawdownPercent: number;
  maximumPortfolioRiskPercent: number;
}): RuntimeRiskAction {
  const reasons: string[] = [];
  const equity = new Decimal(input.equity);
  if (new Decimal(input.dailyPnl).lt(equity.mul(input.dailyLossLimitPercent).div(100).negated()))
    reasons.push('DAILY_LOSS_LIMIT');
  if (new Decimal(input.drawdownPercent).gte(input.maximumDrawdownPercent))
    reasons.push('MAXIMUM_DRAWDOWN');
  if (new Decimal(input.portfolioRiskPercent).gte(input.maximumPortfolioRiskPercent))
    reasons.push('MAXIMUM_PORTFOLIO_RISK');
  return {
    type: reasons.includes('MAXIMUM_DRAWDOWN')
      ? 'KILL_SWITCH'
      : reasons.length > 0
        ? 'ONLY_CLOSE'
        : 'NONE',
    reasons,
  };
}
