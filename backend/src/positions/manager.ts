import { Decimal } from 'decimal.js';

export type ExitReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'BREAK_EVEN'
  | 'TIME_STOP'
  | 'STRATEGY_EXIT'
  | 'RISK_EXIT'
  | 'EMERGENCY_EXIT'
  | 'MANUAL_EXIT';

export interface ManagedPosition {
  readonly id: string;
  readonly symbol: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly openedAt: Date;
  readonly averageEntryPrice: Decimal;
  readonly quantity: Decimal;
  readonly remainingQuantity: Decimal;
  readonly stopLossPrice?: Decimal;
  readonly takeProfitPrice?: Decimal;
  readonly trailingDistance?: Decimal;
  readonly breakEvenTriggerPrice?: Decimal;
  readonly timeStopAt?: Date;
  readonly highWaterPrice: Decimal;
  readonly pendingExitIntentId?: string;
  readonly allowIncrease: boolean;
}

export interface PositionObservation {
  readonly price: Decimal.Value;
  readonly now: Date;
  readonly strategyExit: boolean;
  readonly riskExit: boolean;
  readonly emergencyExit: boolean;
}

export interface ExitInstruction {
  readonly positionId: string;
  readonly symbol: string;
  readonly reason: ExitReason;
  readonly quantity: Decimal;
  readonly fullExit: boolean;
  readonly referencePrice: Decimal;
}

export function evaluatePositionExit(
  position: ManagedPosition,
  observation: PositionObservation,
): ExitInstruction | undefined {
  if (position.pendingExitIntentId !== undefined || !position.remainingQuantity.gt(0))
    return undefined;
  const price = new Decimal(observation.price);
  if (!price.gt(0)) throw new Error('Invalid position observation price');
  let reason: ExitReason | undefined;
  if (observation.emergencyExit) reason = 'EMERGENCY_EXIT';
  else if (observation.riskExit) reason = 'RISK_EXIT';
  else if (position.stopLossPrice !== undefined && price.lte(position.stopLossPrice))
    reason = 'STOP_LOSS';
  else if (
    position.trailingDistance !== undefined &&
    price.lte(position.highWaterPrice.minus(position.trailingDistance))
  )
    reason = 'TRAILING_STOP';
  else if (position.takeProfitPrice !== undefined && price.gte(position.takeProfitPrice))
    reason = 'TAKE_PROFIT';
  else if (position.timeStopAt !== undefined && observation.now >= position.timeStopAt)
    reason = 'TIME_STOP';
  else if (observation.strategyExit) reason = 'STRATEGY_EXIT';
  if (reason === undefined) return undefined;
  return {
    positionId: position.id,
    symbol: position.symbol,
    reason,
    quantity: position.remainingQuantity,
    fullExit: true,
    referencePrice: price,
  };
}

export function reducePosition(
  position: ManagedPosition,
  quantity: Decimal.Value,
  exitIntentId: string,
): ManagedPosition {
  const reduction = new Decimal(quantity);
  if (!reduction.gt(0) || reduction.gt(position.remainingQuantity))
    throw new Error('Invalid position reduction');
  if (position.pendingExitIntentId !== undefined) throw new Error('Position exit already pending');
  return {
    ...position,
    remainingQuantity: position.remainingQuantity.minus(reduction),
    pendingExitIntentId: exitIntentId,
  };
}

export function increasePosition(
  position: ManagedPosition,
  quantity: Decimal.Value,
  fillPrice: Decimal.Value,
): ManagedPosition {
  if (!position.allowIncrease) throw new Error('Position increase is not explicitly enabled');
  const addition = new Decimal(quantity);
  const price = new Decimal(fillPrice);
  if (!addition.gt(0) || !price.gt(0)) throw new Error('Invalid position increase');
  const newQuantity = position.remainingQuantity.plus(addition);
  const average = position.averageEntryPrice
    .mul(position.remainingQuantity)
    .plus(price.mul(addition))
    .div(newQuantity);
  return {
    ...position,
    averageEntryPrice: average,
    quantity: position.quantity.plus(addition),
    remainingQuantity: newQuantity,
    highWaterPrice: Decimal.max(position.highWaterPrice, price),
  };
}

export function updatePositionProtection(
  position: ManagedPosition,
  currentPrice: Decimal.Value,
): ManagedPosition {
  const price = new Decimal(currentPrice);
  const highWaterPrice = Decimal.max(position.highWaterPrice, price);
  const stopLossPrice =
    position.breakEvenTriggerPrice !== undefined && price.gte(position.breakEvenTriggerPrice)
      ? Decimal.max(position.stopLossPrice ?? 0, position.averageEntryPrice)
      : position.stopLossPrice;
  return { ...position, highWaterPrice, ...(stopLossPrice === undefined ? {} : { stopLossPrice }) };
}
