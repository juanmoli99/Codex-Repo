import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { AlpacaOrder, AlpacaOrderRequest } from '../alpaca/types.js';
import type { TradingMode } from '@aegis/shared';
import { AlpacaUnknownOutcomeError } from '../alpaca/http-client.js';
import type { RiskDecision } from '../risk/pre-trade.js';
import type { PositionSizingResult } from '../risk/position-sizing.js';
import type { OperationalSafetyService } from '../safety/service.js';
import type { StrategySignal } from '../strategies/types.js';
import { brokerStatusToOrderState, OrderAggregate } from './order-state-machine.js';
import type { OrderState, OrderTransition } from './order-state-machine.js';

export type TradeIntentState =
  | 'CREATED'
  | 'VALIDATING'
  | 'APPROVED'
  | 'EXECUTING'
  | 'SUBMITTED'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'COMPLETED';

export type AdvancedOrderClass = 'simple' | 'bracket' | 'oco' | 'oto';

export interface OrderSpecification {
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
  readonly timeInForce: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
  readonly orderClass: AdvancedOrderClass;
  readonly limitPrice?: Decimal.Value;
  readonly stopPrice?: Decimal.Value;
  readonly trailPrice?: Decimal.Value;
  readonly trailPercent?: Decimal.Value;
  readonly takeProfitPrice?: Decimal.Value;
  readonly stopLossPrice?: Decimal.Value;
  readonly stopLossLimitPrice?: Decimal.Value;
  readonly extendedHours: boolean;
  readonly pricePrecision: number;
  readonly maximumPriceDeviationBps: number;
}

export interface TradeIntent {
  readonly id: string;
  readonly deduplicationKey: string;
  readonly signal: StrategySignal;
  readonly specification: OrderSpecification;
  readonly createdAt: Date;
  readonly correlationId: string;
  readonly parentIntentId?: string;
  readonly immutableConfigurationSnapshot: Readonly<Record<string, unknown>>;
}

export interface TradeExecutionResult {
  readonly intentId: string;
  readonly intentState: TradeIntentState;
  readonly order?: OrderAggregate;
  readonly brokerOrder?: AlpacaOrder;
  readonly reasons: readonly string[];
  readonly reconciliationRequired: boolean;
}

export interface TradeExecutionRepository {
  executeWithIntentLock<T>(intent: TradeIntent, operation: () => Promise<T>): Promise<T>;
  hasActiveProtection(symbol: string, strategyId: string): Promise<boolean>;
  findByDeduplicationKey(key: string): Promise<TradeExecutionResult | undefined>;
  saveIntent(intent: TradeIntent, state: TradeIntentState): Promise<void>;
  saveOrder(order: OrderAggregate, request: AlpacaOrderRequest): Promise<void>;
  appendTransition(orderId: string, transition: OrderTransition): Promise<void>;
  saveBrokerResponse(orderId: string, response: AlpacaOrder): Promise<void>;
  updateIntentState(
    intentId: string,
    state: TradeIntentState,
    reasons: readonly string[],
  ): Promise<void>;
  saveResult(key: string, result: TradeExecutionResult): Promise<void>;
}

export interface TradeExecutorDependencies {
  readonly repository: TradeExecutionRepository;
  readonly safety: OperationalSafetyService;
  readonly tradingMode: TradingMode;
  readonly submitOrder: (order: AlpacaOrderRequest) => Promise<AlpacaOrder>;
  readonly finalValidate: (intent: TradeIntent) => Promise<readonly string[]>;
  readonly finalRiskGate: (
    intent: TradeIntent,
    sizing: PositionSizingResult,
  ) => Promise<RiskDecision>;
  readonly recalculateSizing: (intent: TradeIntent) => Promise<PositionSizingResult>;
  readonly getReferencePrice: (symbol: string) => Promise<Decimal.Value>;
  readonly requestReconciliation: (clientOrderId: string, reason: string) => Promise<void>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export class TradeExecutor {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(private readonly dependencies: TradeExecutorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async execute(intent: TradeIntent): Promise<TradeExecutionResult> {
    const existing = await this.dependencies.repository.findByDeduplicationKey(
      intent.deduplicationKey,
    );
    if (existing !== undefined) return existing;
    return this.dependencies.repository.executeWithIntentLock(intent, async () => {
      const lockedExisting = await this.dependencies.repository.findByDeduplicationKey(
        intent.deduplicationKey,
      );
      if (lockedExisting !== undefined) return lockedExisting;
      await this.dependencies.repository.saveIntent(intent, 'CREATED');
      await this.dependencies.repository.updateIntentState(intent.id, 'VALIDATING', []);
      const reasons = [...(await this.dependencies.finalValidate(intent))];
      const sizing = await this.dependencies.recalculateSizing(intent);
      if (!sizing.approved) reasons.push(...sizing.reasons.map((reason) => `SIZING:${reason}`));
      const risk = await this.dependencies.finalRiskGate(intent, sizing);
      if (risk.outcome === 'REJECTED')
        reasons.push(...risk.reasonCodes.map((reason) => `RISK:${reason}`));
      const safetyAllowed =
        intent.signal.type === 'EXIT' || intent.specification.side === 'sell'
          ? this.dependencies.safety.canExit(this.dependencies.tradingMode)
          : this.dependencies.safety.canEnter({
              expectedMode: this.dependencies.tradingMode,
              strategyId: intent.signal.strategyId,
              symbol: intent.signal.symbol,
            });
      if (!safetyAllowed) reasons.push('SAFETY_GATE_REJECTED');
      const referencePrice = new Decimal(
        await this.dependencies.getReferencePrice(intent.signal.symbol),
      );
      reasons.push(...validateOrder(intent, sizing, referencePrice));
      if (!sizing.quantity.gt(0))
        return await this.finishWithoutOrder(intent, 'REJECTED', reasons, false);
      const orderId = this.idFactory();
      const clientOrderId = createClientOrderId(intent.id, orderId);
      const order = new OrderAggregate(
        orderId,
        intent.id,
        clientOrderId,
        intent.signal.symbol,
        intent.specification.side,
        sizing.quantity,
      );
      const request = buildOrderRequest(intent, sizing, clientOrderId);
      await this.dependencies.repository.saveOrder(order, request);
      await this.persistTransition(order, 'VALIDATING', 'Final execution validation started');
      if (reasons.length > 0) {
        await this.persistTransition(order, 'REJECTED', reasons.join('; '));
        return await this.finish(intent, order, 'REJECTED', reasons, false);
      }
      if (intent.specification.orderClass !== 'simple') {
        const protectionKey = `${intent.signal.symbol}|${intent.signal.strategyId}`;
        if (
          await this.dependencies.repository.hasActiveProtection(
            intent.signal.symbol,
            intent.signal.strategyId,
          )
        )
          return await this.rejectDuplicateProtection(intent, order, protectionKey);
      }
      await this.persistTransition(order, 'APPROVED', `Risk decision ${risk.id} approved`);
      await this.dependencies.repository.updateIntentState(intent.id, 'EXECUTING', []);
      await this.persistTransition(order, 'SUBMITTING', 'Persisted before broker submit');
      const stillAllowed =
        intent.signal.type === 'EXIT' || intent.specification.side === 'sell'
          ? this.dependencies.safety.canExit(this.dependencies.tradingMode)
          : this.dependencies.safety.canEnter({
              expectedMode: this.dependencies.tradingMode,
              strategyId: intent.signal.strategyId,
              symbol: intent.signal.symbol,
            });
      if (!stillAllowed) {
        const submitReasons = ['SAFETY_CHANGED_BEFORE_SUBMIT'] as const;
        await this.persistTransition(order, 'REJECTED', submitReasons[0]);
        return await this.finish(intent, order, 'REJECTED', submitReasons, false);
      }
      try {
        const response = await this.dependencies.submitOrder(request);
        await this.dependencies.repository.saveBrokerResponse(order.id, response);
        await this.persistTransition(order, 'SUBMITTED', `Broker acknowledged ${response.id}`);
        const brokerState = brokerStatusToOrderState(response.status);
        if (brokerState !== 'SUBMITTED')
          await this.persistTransition(
            order,
            brokerState,
            'Broker response state',
            response.status,
          );
        return await this.finish(
          intent,
          order,
          'SUBMITTED',
          [],
          brokerState === 'UNKNOWN',
          response,
        );
      } catch (error) {
        if (error instanceof AlpacaUnknownOutcomeError) {
          await this.persistTransition(order, 'UNKNOWN', error.message);
          await this.dependencies.requestReconciliation(clientOrderId, error.message);
          return await this.finish(intent, order, 'UNKNOWN', [error.code], true);
        }
        await this.persistTransition(
          order,
          'REJECTED',
          error instanceof Error ? error.message : 'Broker submit rejected',
        );
        return await this.finish(
          intent,
          order,
          'REJECTED',
          [error instanceof Error ? error.message : 'BROKER_SUBMIT_REJECTED'],
          false,
        );
      }
    });
  }

  private async persistTransition(
    order: OrderAggregate,
    next: OrderState,
    reason: string,
    brokerStatus?: string,
  ) {
    const transition = order.transition(next, reason, this.now(), brokerStatus);
    await this.dependencies.repository.appendTransition(order.id, transition);
  }

  private async finish(
    intent: TradeIntent,
    order: OrderAggregate,
    intentState: TradeIntentState,
    reasons: readonly string[],
    reconciliationRequired: boolean,
    brokerOrder?: AlpacaOrder,
  ): Promise<TradeExecutionResult> {
    const result: TradeExecutionResult = {
      intentId: intent.id,
      intentState,
      order,
      ...(brokerOrder === undefined ? {} : { brokerOrder }),
      reasons,
      reconciliationRequired,
    };
    await this.dependencies.repository.updateIntentState(intent.id, intentState, reasons);
    await this.dependencies.repository.saveResult(intent.deduplicationKey, result);
    return result;
  }

  private async finishWithoutOrder(
    intent: TradeIntent,
    intentState: TradeIntentState,
    reasons: readonly string[],
    reconciliationRequired: boolean,
  ): Promise<TradeExecutionResult> {
    const result: TradeExecutionResult = {
      intentId: intent.id,
      intentState,
      reasons,
      reconciliationRequired,
    };
    await this.dependencies.repository.updateIntentState(intent.id, intentState, reasons);
    await this.dependencies.repository.saveResult(intent.deduplicationKey, result);
    return result;
  }

  private async rejectDuplicateProtection(
    intent: TradeIntent,
    order: OrderAggregate,
    protectionKey: string,
  ): Promise<TradeExecutionResult> {
    const reasons = [`DUPLICATE_POSITION_PROTECTION:${protectionKey}`];
    await this.persistTransition(order, 'REJECTED', reasons[0] ?? 'Duplicate protection');
    return this.finish(intent, order, 'REJECTED', reasons, false);
  }
}

function createClientOrderId(intentId: string, orderId: string): string {
  return `aegis-${intentId.replaceAll('-', '').slice(0, 16)}-${orderId.replaceAll('-', '').slice(0, 16)}`;
}

function decimal(value: Decimal.Value | undefined, precision: number): string | undefined {
  return value === undefined
    ? undefined
    : new Decimal(value).toDecimalPlaces(precision, Decimal.ROUND_HALF_UP).toFixed();
}

export function buildOrderRequest(
  intent: TradeIntent,
  sizing: PositionSizingResult,
  clientOrderId: string,
): AlpacaOrderRequest {
  const specification = intent.specification;
  const limitPrice = decimal(specification.limitPrice, specification.pricePrecision);
  const stopPrice = decimal(specification.stopPrice, specification.pricePrecision);
  const stopLossPrice = decimal(specification.stopLossPrice, specification.pricePrecision);
  const stopLossLimit = decimal(specification.stopLossLimitPrice, specification.pricePrecision);
  const takeProfit = decimal(specification.takeProfitPrice, specification.pricePrecision);
  return {
    symbol: intent.signal.symbol,
    side: specification.side,
    type: specification.type,
    time_in_force: specification.timeInForce,
    client_order_id: clientOrderId,
    qty: sizing.quantity.toFixed(),
    ...(limitPrice === undefined ? {} : { limit_price: limitPrice }),
    ...(stopPrice === undefined ? {} : { stop_price: stopPrice }),
    ...(specification.trailPrice === undefined
      ? {}
      : {
          trail_price: new Decimal(specification.trailPrice)
            .toDecimalPlaces(specification.pricePrecision, Decimal.ROUND_HALF_UP)
            .toFixed(),
        }),
    ...(specification.trailPercent === undefined
      ? {}
      : { trail_percent: new Decimal(specification.trailPercent).toFixed() }),
    extended_hours: specification.extendedHours,
    order_class: specification.orderClass,
    ...(takeProfit === undefined ? {} : { take_profit: { limit_price: takeProfit } }),
    ...(stopLossPrice === undefined
      ? {}
      : {
          stop_loss: {
            stop_price: stopLossPrice,
            ...(stopLossLimit === undefined ? {} : { limit_price: stopLossLimit }),
          },
        }),
  };
}

function validateOrder(
  intent: TradeIntent,
  sizing: PositionSizingResult,
  referencePrice: Decimal,
): readonly string[] {
  const specification = intent.specification;
  const reasons: string[] = [];
  if (!sizing.quantity.gt(0) || !sizing.notional.gt(0))
    reasons.push('INVALID_QUANTITY_OR_NOTIONAL');
  if (!referencePrice.gt(0)) reasons.push('INVALID_REFERENCE_PRICE');
  if (specification.type === 'limit' || specification.type === 'stop_limit') {
    if (specification.limitPrice === undefined) reasons.push('LIMIT_PRICE_REQUIRED');
  }
  if (specification.type === 'stop' || specification.type === 'stop_limit') {
    if (specification.stopPrice === undefined) reasons.push('STOP_PRICE_REQUIRED');
  }
  if (specification.type === 'trailing_stop') {
    if (
      (specification.trailPrice === undefined) === (specification.trailPercent === undefined) ||
      specification.orderClass !== 'simple'
    )
      reasons.push('TRAILING_STOP_REQUIRES_ONE_TRAIL_VALUE_AND_SIMPLE_CLASS');
  }
  if (
    specification.extendedHours &&
    (specification.type !== 'limit' || specification.timeInForce !== 'day')
  )
    reasons.push('EXTENDED_HOURS_REQUIRES_DAY_LIMIT_ORDER');
  if (['bracket', 'oco'].includes(specification.orderClass)) {
    if (specification.takeProfitPrice === undefined || specification.stopLossPrice === undefined)
      reasons.push('PROTECTIVE_LEGS_REQUIRED');
  }
  for (const price of [specification.limitPrice, specification.stopPrice]) {
    if (price === undefined || !referencePrice.gt(0)) continue;
    const deviation = new Decimal(price)
      .minus(referencePrice)
      .abs()
      .div(referencePrice)
      .mul(10_000);
    if (deviation.gt(specification.maximumPriceDeviationBps))
      reasons.push('PRICE_SANITY_DEVIATION');
  }
  const signalPriceValue = intent.signal.configurationSnapshot.signalPrice;
  if (
    (typeof signalPriceValue === 'string' || typeof signalPriceValue === 'number') &&
    referencePrice.gt(0)
  ) {
    try {
      const signalPrice = new Decimal(signalPriceValue);
      if (!signalPrice.gt(0)) reasons.push('INVALID_SIGNAL_REFERENCE_PRICE');
      else if (
        referencePrice
          .minus(signalPrice)
          .abs()
          .div(signalPrice)
          .mul(10_000)
          .gt(specification.maximumPriceDeviationBps)
      )
        reasons.push('SIGNAL_TO_EXECUTION_PRICE_DEVIATION');
    } catch {
      reasons.push('INVALID_SIGNAL_REFERENCE_PRICE');
    }
  }
  return [...new Set(reasons)];
}
