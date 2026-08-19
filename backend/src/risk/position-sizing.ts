import { Decimal } from 'decimal.js';
import type { RiskConfigurationSnapshot } from './config.js';

export interface PositionSizingInput {
  readonly symbol: string;
  readonly equity: Decimal.Value;
  readonly cash: Decimal.Value;
  readonly buyingPower: Decimal.Value;
  readonly entryPrice: Decimal.Value;
  readonly stopPrice?: Decimal.Value;
  readonly atr?: Decimal.Value;
  readonly atrMultiple?: Decimal.Value;
  readonly existingExposure: Decimal.Value;
  readonly pendingExposure: Decimal.Value;
  readonly minimumQuantity: Decimal.Value;
  readonly maximumQuantity?: Decimal.Value;
  readonly maximumNotional?: Decimal.Value;
  readonly fractionable: boolean;
  readonly quantityPrecision: number;
  readonly pricePrecision: number;
}

export interface PositionSizingResult {
  readonly approved: boolean;
  readonly quantity: Decimal;
  readonly roundedEntryPrice: Decimal;
  readonly notional: Decimal;
  readonly monetaryRisk: Decimal;
  readonly riskPercent: Decimal;
  readonly stopDistance: Decimal;
  readonly bindingConstraint?: string;
  readonly reasons: readonly string[];
  readonly calculation: Readonly<Record<string, string>>;
}

function floorToPrecision(value: Decimal, precision: number): Decimal {
  if (!Number.isInteger(precision) || precision < 0 || precision > 12)
    throw new Error('Invalid quantity precision');
  return value.toDecimalPlaces(precision, Decimal.ROUND_FLOOR);
}

export function sizePosition(
  input: PositionSizingInput,
  snapshot: RiskConfigurationSnapshot,
): PositionSizingResult {
  const configuration = snapshot.configuration;
  const equity = new Decimal(input.equity);
  const cash = new Decimal(input.cash);
  const buyingPower = new Decimal(input.buyingPower);
  const entryPrice = new Decimal(input.entryPrice).toDecimalPlaces(
    input.pricePrecision,
    Decimal.ROUND_HALF_UP,
  );
  const stopDistance =
    input.stopPrice !== undefined
      ? entryPrice.minus(input.stopPrice).abs()
      : input.atr !== undefined && input.atrMultiple !== undefined
        ? new Decimal(input.atr).mul(input.atrMultiple)
        : new Decimal(0);
  const reasons: string[] = [];
  if (!equity.gt(0)) reasons.push('EQUITY_NOT_POSITIVE');
  if (!entryPrice.gt(0)) reasons.push('ENTRY_PRICE_NOT_POSITIVE');
  if (!stopDistance.gt(0)) reasons.push('STOP_DISTANCE_NOT_POSITIVE');
  if (reasons.length > 0) return rejected(entryPrice, stopDistance, reasons, snapshot.id);

  const riskBudget = Decimal.min(
    equity.mul(configuration.maximumRiskPerTradePercent).div(100),
    configuration.maximumLossPerTrade,
  );
  const riskQuantity = riskBudget.div(stopDistance);
  const symbolLimit = configuration.symbolLimits[input.symbol];
  const exposureLimitPercent =
    symbolLimit?.maximumExposurePercent ?? configuration.maximumAssetExposurePercent;
  const exposureRoom = Decimal.max(
    0,
    equity
      .mul(exposureLimitPercent)
      .div(100)
      .minus(input.existingExposure)
      .minus(input.pendingExposure),
  );
  const notionalCaps: { name: string; value: Decimal }[] = [
    {
      name: 'SYSTEM_MAXIMUM_ORDER_NOTIONAL',
      value: new Decimal(configuration.maximumOrderNotional),
    },
    {
      name: 'MAXIMUM_CAPITAL_PERCENT',
      value: equity.mul(configuration.maximumCapitalPerTradePercent).div(100),
    },
    { name: 'AVAILABLE_CASH', value: Decimal.max(0, cash.minus(configuration.minimumCash)) },
    {
      name: 'AVAILABLE_BUYING_POWER',
      value: Decimal.max(0, buyingPower.minus(configuration.minimumBuyingPower)),
    },
    { name: 'ASSET_EXPOSURE', value: exposureRoom },
    {
      name: 'SYSTEM_MAXIMUM_TOTAL_CAPITAL',
      value: Decimal.max(
        0,
        new Decimal(configuration.maximumTotalCapital)
          .minus(input.existingExposure)
          .minus(input.pendingExposure),
      ),
    },
  ];
  if (input.maximumNotional !== undefined)
    notionalCaps.push({
      name: 'INPUT_MAXIMUM_NOTIONAL',
      value: new Decimal(input.maximumNotional),
    });
  if (symbolLimit !== undefined)
    notionalCaps.push({
      name: 'SYMBOL_MAXIMUM_NOTIONAL',
      value: new Decimal(symbolLimit.maximumNotional),
    });
  const binding = notionalCaps.reduce((lowest, candidate) =>
    candidate.value.lt(lowest.value) ? candidate : lowest,
  );
  let quantity = Decimal.min(riskQuantity, binding.value.div(entryPrice));
  if (input.maximumQuantity !== undefined)
    quantity = Decimal.min(quantity, new Decimal(input.maximumQuantity));
  quantity = floorToPrecision(quantity, input.fractionable ? input.quantityPrecision : 0);
  const minimumQuantity = new Decimal(input.minimumQuantity);
  if (!quantity.gt(0)) reasons.push('NO_CAPACITY_AVAILABLE');
  if (quantity.lt(minimumQuantity)) reasons.push('BELOW_MINIMUM_QUANTITY');
  const notional = quantity.mul(entryPrice);
  const monetaryRisk = quantity.mul(stopDistance);
  if (monetaryRisk.gt(riskBudget)) reasons.push('RISK_BUDGET_EXCEEDED_AFTER_ROUNDING');
  if (notional.gt(binding.value)) reasons.push('NOTIONAL_CAP_EXCEEDED_AFTER_ROUNDING');
  return {
    approved: reasons.length === 0,
    quantity,
    roundedEntryPrice: entryPrice,
    notional,
    monetaryRisk,
    riskPercent: equity.isZero() ? new Decimal(0) : monetaryRisk.div(equity).mul(100),
    stopDistance,
    bindingConstraint: riskQuantity.lte(binding.value.div(entryPrice))
      ? 'RISK_BUDGET'
      : binding.name,
    reasons,
    calculation: {
      riskConfigurationSnapshotId: snapshot.id,
      riskBudget: riskBudget.toFixed(),
      riskQuantity: riskQuantity.toFixed(),
      exposureRoom: exposureRoom.toFixed(),
      notionalCap: binding.value.toFixed(),
    },
  };
}

function rejected(
  entryPrice: Decimal,
  stopDistance: Decimal,
  reasons: readonly string[],
  snapshotId: string,
): PositionSizingResult {
  return {
    approved: false,
    quantity: new Decimal(0),
    roundedEntryPrice: entryPrice,
    notional: new Decimal(0),
    monetaryRisk: new Decimal(0),
    riskPercent: new Decimal(0),
    stopDistance,
    reasons,
    calculation: { riskConfigurationSnapshotId: snapshotId },
  };
}
