import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { MarketBar } from '../market-data/types.js';
import { timeframeMilliseconds } from '../market-data/types.js';
import { StrategyEngine } from '../strategies/engine.js';
import type { StrategyContext, StrategyDefinition } from '../strategies/types.js';

export interface BacktestConfiguration {
  readonly id: string;
  readonly symbol: string;
  readonly from: Date;
  readonly to: Date;
  readonly initialCapital: Decimal.Value;
  readonly warmupBars: number;
  readonly stopLossPercent: number;
  readonly takeProfitPercent: number;
  readonly slippageBps: number;
  readonly commissionPerShare: Decimal.Value;
  readonly annualizationPeriods: number;
  readonly halfSpreadBps?: number;
  readonly marketImpactBps?: number;
  readonly maximumParticipationRate?: number;
  readonly minimumSampleSize?: number;
}

export interface BacktestTrade {
  readonly id: string;
  readonly symbol: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly configurationVersion: string;
  readonly entrySignalAt: Date;
  readonly enteredAt: Date;
  readonly entryPrice: Decimal;
  readonly quantity: Decimal;
  readonly exitedAt: Date;
  readonly exitPrice: Decimal;
  readonly exitReason: 'STOP' | 'TARGET' | 'STRATEGY' | 'SESSION_CLOSE' | 'END_OF_TEST';
  readonly commission: Decimal;
  readonly pnl: Decimal;
  readonly holdingMs: number;
}

export interface BacktestEquityPoint {
  readonly timestamp: Date;
  readonly equity: Decimal;
  readonly drawdownPercent: Decimal;
}

export interface BacktestMetrics {
  readonly netProfit: Decimal;
  readonly grossProfit: Decimal;
  readonly grossLoss: Decimal;
  readonly winRate: Decimal;
  readonly averageWin: Decimal;
  readonly averageLoss: Decimal;
  readonly profitFactor: Decimal | null;
  readonly expectancy: Decimal;
  readonly sharpeRatio: Decimal | null;
  readonly sortinoRatio: Decimal | null;
  readonly calmarRatio: Decimal | null;
  readonly maximumDrawdownPercent: Decimal;
  readonly averageHoldingMs: number;
  readonly consecutiveWins: number;
  readonly consecutiveLosses: number;
  readonly bestTrade: Decimal | null;
  readonly worstTrade: Decimal | null;
  readonly tradeCount: number;
  readonly sampleSufficient: boolean;
  readonly strategyReturnPercent: Decimal;
  readonly benchmarkReturnPercent: Decimal;
  readonly alphaPercent: Decimal;
  readonly turnover: Decimal;
  readonly capacityConstrainedTrades: number;
  readonly bootstrapPnlP05: Decimal | null;
  readonly bootstrapPnlP50: Decimal | null;
  readonly bootstrapPnlP95: Decimal | null;
}

export interface BacktestResult {
  readonly id: string;
  readonly configuration: BacktestConfiguration;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly configurationVersion: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly trades: readonly BacktestTrade[];
  readonly equityCurve: readonly BacktestEquityPoint[];
  readonly metrics: BacktestMetrics;
}

export interface BacktestDependencies {
  readonly loadHistoricalBars: (
    symbol: string,
    from: Date,
    to: Date,
  ) => Promise<readonly MarketBar[]>;
  readonly buildStrategyContext: (
    barsVisibleSoFar: readonly MarketBar[],
    strategy: StrategyDefinition,
    hasPosition: boolean,
  ) => StrategyContext;
  readonly calculateQuantity: (input: {
    equity: Decimal;
    cash: Decimal;
    entryPrice: Decimal;
    stopPrice: Decimal;
  }) => Decimal;
  readonly riskAllowsEntry: (input: {
    timestamp: Date;
    equity: Decimal;
    cash: Decimal;
    price: Decimal;
    quantity: Decimal;
  }) => boolean;
  readonly persist: (result: BacktestResult) => Promise<void>;
  readonly isSessionBar?: (bar: MarketBar, strategy: StrategyDefinition) => boolean;
  readonly onProgress?: (percent: number) => Promise<void>;
  readonly shouldCancel?: () => Promise<boolean>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

interface OpenPosition {
  readonly entrySignalAt: Date;
  readonly enteredAt: Date;
  readonly entryPrice: Decimal;
  readonly quantity: Decimal;
  readonly entryCommission: Decimal;
  readonly stopPrice: Decimal;
  readonly targetPrice: Decimal;
}

export class BacktestEngine {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(private readonly dependencies: BacktestDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async run(
    configuration: BacktestConfiguration,
    strategy: StrategyDefinition,
  ): Promise<BacktestResult> {
    validateConfiguration(configuration);
    const startedAt = this.now();
    const historyFrom = new Date(
      configuration.from.getTime() -
        Math.max(
          10 * 86_400_000,
          configuration.warmupBars * timeframeMilliseconds(strategy.timeframe) * 10,
        ),
    );
    const loaded = await this.dependencies.loadHistoricalBars(
      configuration.symbol,
      historyFrom,
      configuration.to,
    );
    const history = validateBars(loaded, configuration, historyFrom);
    const sessionHistory = history.filter(
      (bar) => this.dependencies.isSessionBar?.(bar, strategy) ?? true,
    );
    const prePeriod = sessionHistory.filter((bar) => bar.timestamp < configuration.from);
    if (prePeriod.length < configuration.warmupBars)
      throw new Error('Warm-up history must precede the test period');
    const bars = sessionHistory.filter(
      (bar) => bar.timestamp >= configuration.from && bar.timestamp <= configuration.to,
    );
    if (bars.length === 0) throw new Error('No in-session bars in the test period');
    const strategyEngine = new StrategyEngine({
      configurationSnapshot: { backtestConfigurationId: configuration.id },
      idFactory: this.idFactory,
    });
    strategyEngine.register(strategy);
    const effectiveConfiguration: BacktestConfiguration = {
      ...configuration,
      annualizationPeriods: annualizationPeriodsFor(strategy.timeframe),
    };
    let cash = new Decimal(configuration.initialCapital);
    let position: OpenPosition | undefined;
    let pendingEntry: { signaledAt: Date; expiresAt: Date } | undefined;
    let pendingStrategyExit = false;
    const trades: BacktestTrade[] = [];
    const dailyEntries = new Map<string, number>();
    const equityCurve: BacktestEquityPoint[] = [];
    let highWater = cash;
    let capacityConstrainedTrades = 0;

    for (let index = 0; index < bars.length; index += 1) {
      if (index % 250 === 0) {
        if (await this.dependencies.shouldCancel?.()) throw new Error('BACKTEST_CANCELED');
        await this.dependencies.onProgress?.(Math.floor((index / bars.length) * 100));
      }
      const bar = requiredAt(bars, index);
      const previousBar = index === 0 ? undefined : requiredAt(bars, index - 1);
      if (
        previousBar !== undefined &&
        marketDayKey(previousBar.timestamp) !== marketDayKey(bar.timestamp)
      ) {
        pendingEntry = undefined;
        pendingStrategyExit = false;
        if (position !== undefined && strategy.overnightPolicy === 'FLAT_AT_CLOSE') {
          const closed = closePosition(
            position,
            previousBar,
            'SESSION_CLOSE',
            effectiveConfiguration,
            strategy,
            this.idFactory,
          );
          cash = cash
            .plus(position.quantity.mul(closed.exitPrice))
            .minus(closed.commission.minus(position.entryCommission));
          trades.push(closed);
          position = undefined;
          highWater = Decimal.max(highWater, cash);
          if (equityCurve.length > 0)
            equityCurve[equityCurve.length - 1] = {
              timestamp: closed.exitedAt,
              equity: cash,
              drawdownPercent: highWater.isZero()
                ? new Decimal(0)
                : highWater.minus(cash).div(highWater).mul(100),
            };
        }
      }
      if (position !== undefined && pendingStrategyExit) {
        const closed = closePosition(
          position,
          bar,
          'STRATEGY',
          effectiveConfiguration,
          strategy,
          this.idFactory,
        );
        cash = cash
          .plus(position.quantity.mul(closed.exitPrice))
          .minus(closed.commission.minus(position.entryCommission));
        trades.push(closed);
        position = undefined;
        pendingStrategyExit = false;
      }
      if (pendingEntry !== undefined && bar.timestamp > pendingEntry.expiresAt)
        pendingEntry = undefined;
      if (position === undefined && pendingEntry !== undefined) {
        const entryDay = marketDayKey(bar.timestamp);
        if ((dailyEntries.get(entryDay) ?? 0) >= strategy.maximumTradesPerDay) {
          pendingEntry = undefined;
        }
      }
      if (position === undefined && pendingEntry !== undefined) {
        const rawEntry = new Decimal(bar.open);
        const entryPrice = applyExecutionCosts(rawEntry, 'buy', effectiveConfiguration);
        const stopPrice = entryPrice.mul(new Decimal(1).minus(configuration.stopLossPercent / 100));
        const requestedQuantity = this.dependencies.calculateQuantity({
          equity: cash,
          cash,
          entryPrice,
          stopPrice,
        });
        const participationCapacity = new Decimal(bar.volume).mul(
          configuration.maximumParticipationRate ?? 1,
        );
        if (requestedQuantity.gt(participationCapacity)) capacityConstrainedTrades += 1;
        const quantity = Decimal.min(requestedQuantity, participationCapacity);
        if (
          quantity.gt(0) &&
          quantity.mul(entryPrice).lte(cash) &&
          this.dependencies.riskAllowsEntry({
            timestamp: bar.timestamp,
            equity: cash,
            cash,
            price: entryPrice,
            quantity,
          })
        ) {
          const entryCommission = quantity.mul(configuration.commissionPerShare);
          cash = cash.minus(quantity.mul(entryPrice)).minus(entryCommission);
          position = {
            entrySignalAt: pendingEntry.signaledAt,
            enteredAt: new Date(bar.timestamp),
            entryPrice,
            quantity,
            entryCommission,
            stopPrice,
            targetPrice: entryPrice.mul(new Decimal(1).plus(configuration.takeProfitPercent / 100)),
          };
          const entryDay = marketDayKey(bar.timestamp);
          dailyEntries.set(entryDay, (dailyEntries.get(entryDay) ?? 0) + 1);
        }
        pendingEntry = undefined;
      }

      if (position !== undefined) {
        const exitReason =
          bar.low <= position.stopPrice.toNumber()
            ? 'STOP'
            : bar.high >= position.targetPrice.toNumber()
              ? 'TARGET'
              : undefined;
        if (exitReason !== undefined) {
          const closed = closePosition(
            position,
            bar,
            exitReason,
            effectiveConfiguration,
            strategy,
            this.idFactory,
          );
          cash = cash
            .plus(position.quantity.mul(closed.exitPrice))
            .minus(closed.commission.minus(position.entryCommission));
          trades.push(closed);
          position = undefined;
        }
      }

      {
        const visibleBars = Object.freeze(
          sessionHistory.filter((candidate) => candidate.timestamp <= bar.timestamp),
        );
        const builtContext = this.dependencies.buildStrategyContext(
          visibleBars,
          strategy,
          position !== undefined,
        );
        if (builtContext.timestamp.getTime() !== bar.timestamp.getTime())
          throw new Error('Strategy context timestamp violates backtest clock');
        const context: StrategyContext = {
          ...builtContext,
          timestamp: new Date(bar.timestamp.getTime() + timeframeMilliseconds(strategy.timeframe)),
        };
        const signal = (await strategyEngine.evaluate(strategy, context)).signal;
        if (signal?.type === 'BUY' && position === undefined && pendingEntry === undefined)
          pendingEntry = { signaledAt: signal.timestamp, expiresAt: signal.expiresAt };
        if ((signal?.type === 'EXIT' || signal?.type === 'SELL') && position !== undefined)
          pendingStrategyExit = true;
      }
      const markedEquity = cash.plus(position?.quantity.mul(bar.close) ?? 0);
      highWater = Decimal.max(highWater, markedEquity);
      equityCurve.push({
        timestamp: new Date(bar.timestamp.getTime() + timeframeMilliseconds(strategy.timeframe)),
        equity: markedEquity,
        drawdownPercent: highWater.isZero()
          ? new Decimal(0)
          : highWater.minus(markedEquity).div(highWater).mul(100),
      });
    }

    const lastBar = bars.at(-1);
    if (position !== undefined && lastBar !== undefined) {
      const closed = closePosition(
        position,
        lastBar,
        'END_OF_TEST',
        effectiveConfiguration,
        strategy,
        this.idFactory,
      );
      cash = cash
        .plus(position.quantity.mul(closed.exitPrice))
        .minus(closed.commission.minus(position.entryCommission));
      trades.push(closed);
      const high = Decimal.max(highWater, cash);
      equityCurve[equityCurve.length - 1] = {
        timestamp: new Date(
          lastBar.timestamp.getTime() + timeframeMilliseconds(strategy.timeframe),
        ),
        equity: cash,
        drawdownPercent: high.isZero() ? new Decimal(0) : high.minus(cash).div(high).mul(100),
      };
    }
    const result: BacktestResult = {
      id: this.idFactory(),
      configuration: effectiveConfiguration,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      configurationVersion: strategy.configurationVersion,
      startedAt,
      finishedAt: this.now(),
      trades,
      equityCurve,
      metrics: calculateMetrics(
        trades,
        equityCurve,
        bars,
        effectiveConfiguration,
        capacityConstrainedTrades,
      ),
    };
    await this.dependencies.onProgress?.(100);
    await this.dependencies.persist(result);
    return result;
  }
}

function marketDayKey(timestamp: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp);
}

function validateConfiguration(configuration: BacktestConfiguration): void {
  if (configuration.from >= configuration.to) throw new Error('Invalid backtest date range');
  if (!new Decimal(configuration.initialCapital).gt(0))
    throw new Error('Initial capital must be positive');
  if (configuration.warmupBars < 1) throw new Error('Warm-up must include at least one bar');
  if (configuration.stopLossPercent <= 0 || configuration.takeProfitPercent <= 0)
    throw new Error('Stop and target must be positive');
}

function validateBars(
  loaded: readonly MarketBar[],
  configuration: BacktestConfiguration,
  historyFrom: Date,
): readonly MarketBar[] {
  const bars = loaded
    .filter(
      (bar) =>
        bar.symbol === configuration.symbol &&
        bar.timestamp >= historyFrom &&
        bar.timestamp <= configuration.to,
    )
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  if (bars.length < configuration.warmupBars + 1) throw new Error('Insufficient backtest history');
  for (let index = 1; index < bars.length; index += 1)
    if (
      requiredAt(bars, index).timestamp.getTime() <= requiredAt(bars, index - 1).timestamp.getTime()
    )
      throw new Error('Historical bars must have unique ascending timestamps');
  return bars;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing value at ${index}`);
  return value;
}

function applySlippage(price: Decimal, side: 'buy' | 'sell', bps: number): Decimal {
  const factor = new Decimal(bps).div(10_000);
  return side === 'buy'
    ? price.mul(new Decimal(1).plus(factor))
    : price.mul(new Decimal(1).minus(factor));
}

function applyExecutionCosts(
  price: Decimal,
  side: 'buy' | 'sell',
  configuration: BacktestConfiguration,
): Decimal {
  return applySlippage(
    price,
    side,
    configuration.slippageBps +
      (configuration.halfSpreadBps ?? 0) +
      (configuration.marketImpactBps ?? 0),
  );
}

function annualizationPeriodsFor(timeframe: StrategyDefinition['timeframe']): number {
  switch (timeframe) {
    case '1Min':
      return 252 * 390;
    case '5Min':
      return 252 * 78;
    case '15Min':
      return 252 * 26;
    case '1Hour':
      return 252 * 6.5;
    case '1Day':
      return 252;
  }
}

function closePosition(
  position: OpenPosition,
  bar: MarketBar,
  reason: BacktestTrade['exitReason'],
  configuration: BacktestConfiguration,
  strategy: StrategyDefinition,
  idFactory: () => string,
): BacktestTrade {
  const rawPrice =
    reason === 'STOP'
      ? Decimal.min(bar.open, position.stopPrice)
      : reason === 'TARGET'
        ? Decimal.max(bar.open, position.targetPrice)
        : new Decimal(
            reason === 'END_OF_TEST' || reason === 'SESSION_CLOSE' ? bar.close : bar.open,
          );
  const exitPrice = applyExecutionCosts(rawPrice, 'sell', configuration);
  const exitCommission = position.quantity.mul(configuration.commissionPerShare);
  const commission = position.entryCommission.plus(exitCommission);
  return {
    id: idFactory(),
    symbol: configuration.symbol,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    configurationVersion: strategy.configurationVersion,
    entrySignalAt: new Date(position.entrySignalAt),
    enteredAt: new Date(position.enteredAt),
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    exitedAt: new Date(bar.timestamp.getTime() + timeframeMilliseconds(strategy.timeframe)),
    exitPrice,
    exitReason: reason,
    commission,
    pnl: exitPrice.minus(position.entryPrice).mul(position.quantity).minus(commission),
    holdingMs: Math.max(
      0,
      bar.timestamp.getTime() +
        timeframeMilliseconds(strategy.timeframe) -
        position.enteredAt.getTime(),
    ),
  };
}

function calculateMetrics(
  trades: readonly BacktestTrade[],
  equityCurve: readonly BacktestEquityPoint[],
  bars: readonly MarketBar[],
  configuration: BacktestConfiguration,
  capacityConstrainedTrades: number,
): BacktestMetrics {
  const wins = trades.filter((trade) => trade.pnl.gt(0));
  const losses = trades.filter((trade) => trade.pnl.lt(0));
  const grossProfit = wins.reduce((sum, trade) => sum.plus(trade.pnl), new Decimal(0));
  const grossLoss = losses.reduce((sum, trade) => sum.plus(trade.pnl.abs()), new Decimal(0));
  const netProfit = grossProfit.minus(grossLoss);
  const returns = equityCurve.slice(1).map((point, index) => {
    const previous = requiredAt(equityCurve, index).equity;
    return previous.isZero() ? new Decimal(0) : point.equity.minus(previous).div(previous);
  });
  const meanReturn = mean(returns);
  const deviation = standardDeviation(returns, meanReturn);
  const downside = standardDeviation(
    returns.filter((value) => value.lt(0)),
    new Decimal(0),
  );
  const maximumDrawdownPercent = equityCurve.reduce(
    (maximum, point) => Decimal.max(maximum, point.drawdownPercent),
    new Decimal(0),
  );
  const netReturnPercent = new Decimal(configuration.initialCapital).isZero()
    ? new Decimal(0)
    : netProfit.div(configuration.initialCapital).mul(100);
  const streaks = calculateStreaks(trades);
  const firstBar = bars.at(0);
  const lastBar = bars.at(-1);
  const benchmarkReturnPercent =
    firstBar === undefined || lastBar === undefined || firstBar.open <= 0
      ? new Decimal(0)
      : new Decimal(lastBar.close).minus(firstBar.open).div(firstBar.open).mul(100);
  const initialCapital = new Decimal(configuration.initialCapital);
  const turnover = initialCapital.isZero()
    ? new Decimal(0)
    : trades
        .reduce(
          (sum, trade) => sum.plus(trade.entryPrice.plus(trade.exitPrice).mul(trade.quantity)),
          new Decimal(0),
        )
        .div(initialCapital);
  const bootstrap = bootstrapPnlQuantiles(trades, configuration.id);
  return {
    netProfit,
    grossProfit,
    grossLoss,
    winRate:
      trades.length === 0 ? new Decimal(0) : new Decimal(wins.length).div(trades.length).mul(100),
    averageWin: wins.length === 0 ? new Decimal(0) : grossProfit.div(wins.length),
    averageLoss: losses.length === 0 ? new Decimal(0) : grossLoss.div(losses.length),
    profitFactor: grossLoss.isZero() ? null : grossProfit.div(grossLoss),
    expectancy: trades.length === 0 ? new Decimal(0) : netProfit.div(trades.length),
    sharpeRatio:
      deviation === null || deviation.isZero()
        ? null
        : meanReturn.mul(Math.sqrt(configuration.annualizationPeriods)).div(deviation),
    sortinoRatio:
      downside === null || downside.isZero()
        ? null
        : meanReturn.mul(Math.sqrt(configuration.annualizationPeriods)).div(downside),
    calmarRatio: maximumDrawdownPercent.isZero()
      ? null
      : netReturnPercent.div(maximumDrawdownPercent),
    maximumDrawdownPercent,
    averageHoldingMs:
      trades.length === 0
        ? 0
        : trades.reduce((sum, trade) => sum + trade.holdingMs, 0) / trades.length,
    consecutiveWins: streaks.wins,
    consecutiveLosses: streaks.losses,
    bestTrade: trades.length === 0 ? null : Decimal.max(...trades.map((trade) => trade.pnl)),
    worstTrade: trades.length === 0 ? null : Decimal.min(...trades.map((trade) => trade.pnl)),
    tradeCount: trades.length,
    sampleSufficient: trades.length >= (configuration.minimumSampleSize ?? 30),
    strategyReturnPercent: netReturnPercent,
    benchmarkReturnPercent,
    alphaPercent: netReturnPercent.minus(benchmarkReturnPercent),
    turnover,
    capacityConstrainedTrades,
    bootstrapPnlP05: bootstrap?.p05 ?? null,
    bootstrapPnlP50: bootstrap?.p50 ?? null,
    bootstrapPnlP95: bootstrap?.p95 ?? null,
  };
}

function bootstrapPnlQuantiles(
  trades: readonly BacktestTrade[],
  seedText: string,
): { p05: Decimal; p50: Decimal; p95: Decimal } | undefined {
  if (trades.length < 2) return undefined;
  const sample = trades.slice(0, 2_000);
  let seed = 2_166_136_261;
  for (const character of seedText)
    seed = Math.imul(seed ^ character.charCodeAt(0), 16_777_619) >>> 0;
  const random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  const totals: Decimal[] = [];
  for (let simulation = 0; simulation < 500; simulation += 1) {
    let total = new Decimal(0);
    sample.forEach(() => {
      total = total.plus(requiredAt(sample, Math.floor(random() * sample.length)).pnl);
    });
    totals.push(total);
  }
  totals.sort((left, right) => left.comparedTo(right));
  return {
    p05: requiredAt(totals, Math.floor(totals.length * 0.05)),
    p50: requiredAt(totals, Math.floor(totals.length * 0.5)),
    p95: requiredAt(totals, Math.floor(totals.length * 0.95)),
  };
}

function mean(values: readonly Decimal[]): Decimal {
  return values.length === 0
    ? new Decimal(0)
    : values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
}

function standardDeviation(values: readonly Decimal[], average: Decimal): Decimal | null {
  if (values.length < 2) return null;
  const variance = values
    .reduce((sum, value) => sum.plus(value.minus(average).pow(2)), new Decimal(0))
    .div(values.length - 1);
  return variance.sqrt();
}

function calculateStreaks(trades: readonly BacktestTrade[]): { wins: number; losses: number } {
  let wins = 0;
  let losses = 0;
  let currentWins = 0;
  let currentLosses = 0;
  for (const trade of trades) {
    if (trade.pnl.gt(0)) {
      currentWins += 1;
      currentLosses = 0;
    } else if (trade.pnl.lt(0)) {
      currentLosses += 1;
      currentWins = 0;
    }
    wins = Math.max(wins, currentWins);
    losses = Math.max(losses, currentLosses);
  }
  return { wins, losses };
}

export function compareBacktests(results: readonly BacktestResult[]): readonly BacktestResult[] {
  return [...results].sort(
    (left, right) =>
      right.metrics.netProfit.comparedTo(left.metrics.netProfit) ||
      left.metrics.maximumDrawdownPercent.comparedTo(right.metrics.maximumDrawdownPercent),
  );
}
