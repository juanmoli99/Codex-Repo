import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { TradingMode } from '@aegis/shared';
import type { MarketDataHealth } from '../market-data/types.js';
import type { StrategySignal } from '../strategies/types.js';
import type { RiskConfigurationSnapshot } from './config.js';
import type { PositionSizingResult } from './position-sizing.js';

export type RiskDecisionOutcome = 'APPROVED' | 'REJECTED';

export interface PreTradeContext {
  readonly expectedMode: TradingMode;
  readonly actualMode: TradingMode;
  readonly tradingEnabled: boolean;
  readonly systemReady: boolean;
  readonly symbolValid: boolean;
  readonly marketSessionOpen: boolean;
  readonly marketDataHealth: MarketDataHealth;
  readonly signal: StrategySignal;
  readonly now: Date;
  readonly positionSizing: PositionSizingResult;
  readonly equity: Decimal.Value;
  readonly cash: Decimal.Value;
  readonly buyingPower: Decimal.Value;
  readonly currentAssetExposure: Decimal.Value;
  readonly currentGlobalExposure: Decimal.Value;
  readonly pendingAssetExposure: Decimal.Value;
  readonly projectedNotional: Decimal.Value;
  readonly currentConcentrationPercent: Decimal.Value;
  readonly positionCount: number;
  readonly openOrderCount: number;
  readonly dailyTradeCount: number;
  readonly dailyStrategyTradeCount: number;
  readonly dailyPnl: Decimal.Value;
  readonly drawdownPercent: Decimal.Value;
  readonly aggregateRiskPercent: Decimal.Value;
  readonly averageDailyDollarVolume: Decimal.Value;
  readonly spreadBps: Decimal.Value;
  readonly annualizedVolatility: Decimal.Value;
  readonly quotePrice: Decimal.Value;
  readonly duplicateOperation: boolean;
  readonly regulatoryAllowed: boolean;
  readonly regulatoryReasons: readonly string[];
}

export interface RiskDecision {
  readonly id: string;
  readonly outcome: RiskDecisionOutcome;
  readonly signalId: string;
  readonly symbol: string;
  readonly evaluatedAt: Date;
  readonly reasonCodes: readonly string[];
  readonly configurationSnapshotId: string;
  readonly decisionSnapshot: Readonly<Record<string, string | number | boolean>>;
}

export interface RiskDecisionPersistence {
  save(decision: RiskDecision): Promise<void>;
}

export class PreTradeRiskGate {
  public constructor(
    private readonly persistence?: RiskDecisionPersistence,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  public async evaluate(
    context: PreTradeContext,
    snapshot: RiskConfigurationSnapshot,
  ): Promise<RiskDecision> {
    const limits = snapshot.configuration;
    const reasons: string[] = [];
    const notional = new Decimal(context.projectedNotional);
    const equity = new Decimal(context.equity);
    const projectedAssetExposure = new Decimal(context.currentAssetExposure)
      .plus(context.pendingAssetExposure)
      .plus(notional);
    const projectedGlobalExposure = new Decimal(context.currentGlobalExposure).plus(notional.abs());
    const projectedConcentration = equity.gt(0)
      ? projectedAssetExposure.abs().div(equity).mul(100)
      : new Decimal(Infinity);
    const symbolLimit = limits.symbolLimits[context.signal.symbol];
    const strategyLimit = limits.strategyLimits[context.signal.strategyId];
    const maximumAssetExposure =
      symbolLimit?.maximumExposurePercent ?? limits.maximumAssetExposurePercent;

    check(context.tradingEnabled, 'TRADING_DISABLED', reasons);
    check(context.expectedMode === context.actualMode, 'TRADING_MODE_MISMATCH', reasons);
    check(context.systemReady, 'SYSTEM_NOT_READY', reasons);
    check(context.symbolValid, 'INVALID_SYMBOL', reasons);
    check(context.marketSessionOpen, 'MARKET_SESSION_CLOSED', reasons);
    check(context.marketDataHealth === 'HEALTHY', 'MARKET_DATA_NOT_HEALTHY', reasons);
    check(context.signal.expiresAt.getTime() > context.now.getTime(), 'SIGNAL_EXPIRED', reasons);
    check(context.positionSizing.approved, 'POSITION_SIZING_REJECTED', reasons);
    check(notional.gt(0), 'INVALID_NOTIONAL', reasons);
    check(context.positionSizing.quantity.gt(0), 'INVALID_QUANTITY', reasons);
    check(new Decimal(context.quotePrice).gt(0), 'INVALID_PRICE', reasons);
    check(equity.gte(limits.minimumAccountEquity), 'MINIMUM_ACCOUNT_EQUITY_NOT_MET', reasons);
    check(notional.lte(limits.maximumOrderNotional), 'MAXIMUM_ORDER_NOTIONAL_EXCEEDED', reasons);
    if (symbolLimit)
      check(notional.lte(symbolLimit.maximumNotional), 'SYMBOL_MAXIMUM_NOTIONAL_EXCEEDED', reasons);
    if (strategyLimit)
      check(
        context.positionSizing.riskPercent.lte(strategyLimit.maximumRiskPercent),
        'STRATEGY_MAXIMUM_RISK_EXCEEDED',
        reasons,
      );
    check(
      notional.lte(equity.mul(limits.maximumCapitalPerTradePercent).div(100)),
      'MAXIMUM_TRADE_CAPITAL_EXCEEDED',
      reasons,
    );
    check(
      projectedAssetExposure.abs().lte(equity.mul(maximumAssetExposure).div(100)),
      'MAXIMUM_ASSET_EXPOSURE_EXCEEDED',
      reasons,
    );
    check(
      projectedGlobalExposure.lte(equity.mul(limits.maximumGlobalExposurePercent).div(100)),
      'MAXIMUM_GLOBAL_EXPOSURE_EXCEEDED',
      reasons,
    );
    check(
      projectedGlobalExposure.lte(limits.maximumTotalCapital),
      'MAXIMUM_TOTAL_CAPITAL_EXCEEDED',
      reasons,
    );
    check(
      projectedConcentration.lte(limits.maximumConcentrationPercent),
      'MAXIMUM_CONCENTRATION_EXCEEDED',
      reasons,
    );
    check(context.positionCount < limits.maximumPositions, 'MAXIMUM_POSITIONS_REACHED', reasons);
    check(
      context.openOrderCount < limits.maximumOpenOrders,
      'MAXIMUM_OPEN_ORDERS_REACHED',
      reasons,
    );
    check(
      context.dailyTradeCount < limits.maximumDailyTrades,
      'MAXIMUM_DAILY_TRADES_REACHED',
      reasons,
    );
    if (strategyLimit)
      check(
        context.dailyStrategyTradeCount < strategyLimit.maximumDailyTrades,
        'STRATEGY_MAXIMUM_DAILY_TRADES_REACHED',
        reasons,
      );
    check(
      new Decimal(context.dailyPnl).gte(
        equity.mul(limits.dailyLossLimitPercent).div(100).negated(),
      ),
      'DAILY_LOSS_LIMIT_REACHED',
      reasons,
    );
    check(
      new Decimal(context.dailyPnl).gte(new Decimal(limits.dailyLossLimitAmount).negated()),
      'ABSOLUTE_DAILY_LOSS_LIMIT_REACHED',
      reasons,
    );
    check(
      new Decimal(context.drawdownPercent).lte(limits.maximumDrawdownPercent),
      'MAXIMUM_DRAWDOWN_REACHED',
      reasons,
    );
    check(
      new Decimal(context.buyingPower).minus(notional).gte(limits.minimumBuyingPower),
      'INSUFFICIENT_BUYING_POWER',
      reasons,
    );
    check(
      new Decimal(context.cash).minus(notional).gte(limits.minimumCash),
      'INSUFFICIENT_CASH',
      reasons,
    );
    check(
      new Decimal(context.aggregateRiskPercent)
        .plus(context.positionSizing.riskPercent)
        .lte(limits.maximumAggregateRiskPercent),
      'MAXIMUM_AGGREGATE_RISK_EXCEEDED',
      reasons,
    );
    check(
      new Decimal(context.averageDailyDollarVolume).gte(limits.minimumAverageDailyDollarVolume),
      'INSUFFICIENT_LIQUIDITY',
      reasons,
    );
    check(new Decimal(context.spreadBps).lte(limits.maximumSpreadBps), 'SPREAD_TOO_WIDE', reasons);
    check(
      new Decimal(context.annualizedVolatility).lte(limits.maximumAnnualizedVolatility),
      'VOLATILITY_TOO_HIGH',
      reasons,
    );
    check(!context.duplicateOperation, 'DUPLICATE_OPERATION', reasons);
    if (!context.regulatoryAllowed)
      reasons.push(...context.regulatoryReasons.map((reason) => `REGULATORY:${reason}`));

    const decision: RiskDecision = {
      id: this.idFactory(),
      outcome: reasons.length === 0 ? 'APPROVED' : 'REJECTED',
      signalId: context.signal.id,
      symbol: context.signal.symbol,
      evaluatedAt: new Date(context.now),
      reasonCodes: reasons,
      configurationSnapshotId: snapshot.id,
      decisionSnapshot: Object.freeze({
        expectedMode: context.expectedMode,
        actualMode: context.actualMode,
        equity: equity.toFixed(),
        projectedNotional: notional.toFixed(),
        projectedAssetExposure: projectedAssetExposure.toFixed(),
        projectedGlobalExposure: projectedGlobalExposure.toFixed(),
        projectedConcentrationPercent: projectedConcentration.toFixed(),
        positionCount: context.positionCount,
        openOrderCount: context.openOrderCount,
        dailyTradeCount: context.dailyTradeCount,
        dailyStrategyTradeCount: context.dailyStrategyTradeCount,
        cash: new Decimal(context.cash).toFixed(),
        buyingPower: new Decimal(context.buyingPower).toFixed(),
        currentAssetExposure: new Decimal(context.currentAssetExposure).toFixed(),
        currentGlobalExposure: new Decimal(context.currentGlobalExposure).toFixed(),
        pendingAssetExposure: new Decimal(context.pendingAssetExposure).toFixed(),
        currentConcentrationPercent: new Decimal(context.currentConcentrationPercent).toFixed(),
        dailyPnl: new Decimal(context.dailyPnl).toFixed(),
        drawdownPercent: new Decimal(context.drawdownPercent).toFixed(),
        aggregateRiskPercent: new Decimal(context.aggregateRiskPercent).toFixed(),
        positionRiskPercent: context.positionSizing.riskPercent.toFixed(),
        averageDailyDollarVolume: new Decimal(context.averageDailyDollarVolume).toFixed(),
        spreadBps: new Decimal(context.spreadBps).toFixed(),
        annualizedVolatility: new Decimal(context.annualizedVolatility).toFixed(),
        quotePrice: new Decimal(context.quotePrice).toFixed(),
        duplicateOperation: context.duplicateOperation,
        regulatoryAllowed: context.regulatoryAllowed,
        signalExpiresAt: context.signal.expiresAt.toISOString(),
        marketDataHealth: context.marketDataHealth,
      }),
    };
    await this.persistence?.save(decision);
    return decision;
  }
}

function check(condition: boolean, code: string, reasons: string[]): void {
  if (!condition) reasons.push(code);
}
