import { Decimal } from 'decimal.js';

import { type AlpacaAccount, type AlpacaAsset } from '../alpaca/types.js';

export type RegulatoryRegime = 'LEGACY_PDT' | 'INTRADAY_MARGIN' | 'BROKER_TRANSITION';

export interface RegulatoryRuleVersion {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string;
  readonly regime: RegulatoryRegime;
  readonly legacyPdtMinimumEquity: string;
  readonly source: string;
  readonly brokerIsAuthoritative: true;
}

export const DEFAULT_REGULATORY_RULES: RegulatoryRuleVersion = Object.freeze({
  id: 'US_MARGIN_TRANSITION_2026_V1',
  effectiveFrom: '2026-06-04',
  effectiveUntil: '2027-10-20',
  regime: 'BROKER_TRANSITION',
  legacyPdtMinimumEquity: '25000',
  source: 'FINRA-4210-and-broker-account-state',
  brokerIsAuthoritative: true,
});

export interface ProposedRegulatedOrder {
  readonly side: 'buy' | 'sell';
  readonly notional: string;
  readonly wouldOpenOrIncrease: boolean;
  readonly wouldDayTrade: boolean;
  readonly isShortSale: boolean;
}

export interface LocalAccountProjection {
  readonly buyingPower: string;
  readonly cash: string;
  readonly equity: string;
}

export interface AccountRestrictionDecision {
  readonly approved: boolean;
  readonly accountType: 'CASH' | 'MARGIN';
  readonly effectiveBuyingPower: string;
  readonly ruleVersion: string;
  readonly reasons: readonly string[];
  readonly snapshot: Readonly<Record<string, string | number | boolean>>;
}

function minimum(values: readonly Decimal[]): Decimal {
  return values.reduce((result, value) => Decimal.min(result, value));
}

export class AccountRestrictionGuard {
  public constructor(
    private readonly rules: RegulatoryRuleVersion = DEFAULT_REGULATORY_RULES,
    private readonly maximumProjectionDifference = new Decimal('0.01'),
  ) {}

  public evaluate(
    account: AlpacaAccount,
    asset: AlpacaAsset,
    order: ProposedRegulatedOrder,
    local: LocalAccountProjection,
  ): AccountRestrictionDecision {
    const reasons: string[] = [];
    const multiplier = new Decimal(account.multiplier);
    const accountType = multiplier.greaterThan(1) ? 'MARGIN' : 'CASH';
    const brokerBuyingPower = new Decimal(account.buying_power);
    const candidates = [brokerBuyingPower, new Decimal(local.buyingPower)];
    if (order.wouldDayTrade && account.daytrading_buying_power) {
      candidates.push(new Decimal(account.daytrading_buying_power));
    }
    const effectiveBuyingPower = minimum(candidates);
    const notional = new Decimal(order.notional);

    if (account.account_blocked) reasons.push('ACCOUNT_BLOCKED_BY_BROKER');
    if (account.trading_blocked) reasons.push('TRADING_BLOCKED_BY_BROKER');
    if (account.trade_suspended_by_user) reasons.push('TRADING_SUSPENDED_BY_USER');
    if (account.status !== 'ACTIVE') reasons.push('ACCOUNT_NOT_ACTIVE');
    if (!asset.tradable || asset.status !== 'active') reasons.push('ASSET_NOT_TRADABLE');
    if (notional.lte(0)) reasons.push('ORDER_NOTIONAL_INVALID');
    if (order.wouldOpenOrIncrease && notional.gt(effectiveBuyingPower)) {
      reasons.push('REGULATORY_BUYING_POWER_EXCEEDED');
    }

    const projectionDifference = brokerBuyingPower.minus(local.buyingPower).abs();
    if (projectionDifference.gt(this.maximumProjectionDifference)) {
      reasons.push('LOCAL_BROKER_BUYING_POWER_MISMATCH');
    }

    if (accountType === 'CASH') {
      if (order.isShortSale) reasons.push('SHORT_SALE_FORBIDDEN_IN_CASH_ACCOUNT');
      if (order.side === 'buy' && notional.gt(Decimal.min(account.cash, local.cash))) {
        reasons.push('SETTLED_CASH_EXCEEDED');
      }
    } else if (order.isShortSale) {
      if (!account.shorting_enabled) reasons.push('ACCOUNT_SHORTING_DISABLED');
      if (!asset.shortable) reasons.push('ASSET_NOT_SHORTABLE');
      if (!asset.marginable) reasons.push('ASSET_NOT_MARGINABLE');
    }

    // During the FINRA transition, the broker's PDT flag and buying-power fields remain authoritative.
    if (
      account.pattern_day_trader &&
      order.wouldDayTrade &&
      new Decimal(account.equity).lt(this.rules.legacyPdtMinimumEquity) &&
      account.daytrading_buying_power !== undefined &&
      new Decimal(account.daytrading_buying_power).lte(0)
    ) {
      reasons.push('BROKER_PDT_RESTRICTION');
    }

    return Object.freeze({
      approved: reasons.length === 0,
      accountType,
      effectiveBuyingPower: effectiveBuyingPower.toFixed(2),
      ruleVersion: this.rules.id,
      reasons: Object.freeze(reasons),
      snapshot: Object.freeze({
        brokerStatus: account.status,
        patternDayTrader: account.pattern_day_trader,
        daytradeCount: account.daytrade_count,
        brokerBuyingPower: account.buying_power,
        brokerDaytradingBuyingPower: account.daytrading_buying_power ?? 'UNREPORTED',
        localBuyingPower: local.buyingPower,
        accountType,
      }),
    });
  }
}
