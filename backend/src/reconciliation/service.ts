import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type {
  AlpacaAccount,
  AlpacaActivity,
  AlpacaOrder,
  AlpacaPosition,
} from '../alpaca/types.js';
import type { OrderState } from '../execution/order-state-machine.js';
import { brokerStatusToOrderState } from '../execution/order-state-machine.js';

export type ReconciliationTrigger =
  | 'STARTUP'
  | 'SCHEDULED'
  | 'MANUAL'
  | 'SUBMIT_TIMEOUT'
  | 'CRITICAL_ERROR'
  | 'BACKUP_RESTORE'
  | 'RECONNECT';
export type DiscrepancyClassification = 'SAFE_AUTO_CORRECTION' | 'REVIEW_REQUIRED' | 'BLOCKING';

export interface LocalOrderSnapshot {
  readonly id: string;
  readonly brokerOrderId?: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly state: OrderState;
  readonly requestedQuantity: string;
  readonly filledQuantity: string;
}

export interface LocalPositionSnapshot {
  readonly symbol: string;
  readonly quantity: string;
  readonly averageEntryPrice: string;
}

export interface LocalFillSnapshot {
  readonly id: string;
  readonly brokerOrderId?: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly price: string;
}

export interface ReconciliationDiscrepancy {
  readonly code:
    | 'LOCAL_ORDER_MISSING_AT_BROKER'
    | 'EXTERNAL_BROKER_ORDER'
    | 'ORDER_STATUS_MISMATCH'
    | 'ORDER_QUANTITY_MISMATCH'
    | 'BROKER_FILL_MISSING_LOCALLY'
    | 'UNEXPECTED_POSITION'
    | 'MISSING_POSITION'
    | 'POSITION_QUANTITY_MISMATCH'
    | 'POSITION_AVERAGE_ENTRY_PRICE_MISMATCH'
    | 'CASH_MISMATCH'
    | 'EQUITY_MISMATCH'
    | 'BUYING_POWER_MISMATCH';
  readonly classification: DiscrepancyClassification;
  readonly entityId: string;
  readonly localValue?: string;
  readonly brokerValue?: string;
  readonly detail: string;
}

export interface ReconciliationResult {
  readonly id: string;
  readonly trigger: ReconciliationTrigger;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
  readonly safeCorrectionsApplied: number;
  readonly blocked: boolean;
}

export interface ReconciliationInput {
  readonly trigger: ReconciliationTrigger;
  readonly localOrders: readonly LocalOrderSnapshot[];
  readonly localPositions: readonly LocalPositionSnapshot[];
  readonly localFills: readonly LocalFillSnapshot[];
  readonly localAccount: { cash: string; equity: string; buyingPower: string };
  readonly brokerOrders: readonly AlpacaOrder[];
  readonly brokerPositions: readonly AlpacaPosition[];
  readonly brokerFills: readonly AlpacaActivity[];
  readonly brokerAccount: AlpacaAccount;
  readonly moneyTolerance: string;
  readonly quantityTolerance: string;
}

export interface ReconciliationDependencies {
  readonly applySafeOrderStateCorrection: (
    localOrderId: string,
    brokerState: OrderState,
  ) => Promise<void>;
  readonly persist: (result: ReconciliationResult) => Promise<void>;
  readonly blockSafety: (result: ReconciliationResult) => Promise<void>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

function mismatch(left: string, right: string, tolerance: string): boolean {
  return new Decimal(left).minus(right).abs().gt(tolerance);
}

export class ReconciliationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(private readonly dependencies: ReconciliationDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async reconcile(input: ReconciliationInput): Promise<ReconciliationResult> {
    const id = this.idFactory();
    const startedAt = this.now();
    const discrepancies: ReconciliationDiscrepancy[] = [];
    let safeCorrectionsApplied = 0;
    const brokerOrdersByClientId = new Map(
      input.brokerOrders.map((order) => [order.client_order_id, order]),
    );
    const localOrdersByClientId = new Map(
      input.localOrders.map((order) => [order.clientOrderId, order]),
    );
    for (const local of input.localOrders) {
      const broker = brokerOrdersByClientId.get(local.clientOrderId);
      if (broker === undefined) {
        if (!['CREATED', 'VALIDATING', 'APPROVED'].includes(local.state))
          discrepancies.push({
            code: 'LOCAL_ORDER_MISSING_AT_BROKER',
            classification: 'BLOCKING',
            entityId: local.id,
            localValue: local.state,
            detail: 'Submitted local order is not present at broker',
          });
        continue;
      }
      const brokerState = brokerStatusToOrderState(broker.status);
      if (brokerState !== local.state) {
        const safe = isMonotonicTerminalCorrection(local.state, brokerState);
        discrepancies.push({
          code: 'ORDER_STATUS_MISMATCH',
          classification: safe ? 'SAFE_AUTO_CORRECTION' : 'BLOCKING',
          entityId: local.id,
          localValue: local.state,
          brokerValue: brokerState,
          detail: 'Local and broker order states differ',
        });
        if (safe) {
          await this.dependencies.applySafeOrderStateCorrection(local.id, brokerState);
          safeCorrectionsApplied += 1;
        }
      }
      if (
        broker.qty !== null &&
        broker.qty !== undefined &&
        mismatch(local.requestedQuantity, broker.qty, input.quantityTolerance)
      )
        discrepancies.push({
          code: 'ORDER_QUANTITY_MISMATCH',
          classification: 'BLOCKING',
          entityId: local.id,
          localValue: local.requestedQuantity,
          brokerValue: broker.qty,
          detail: 'Requested quantities differ',
        });
    }
    for (const broker of input.brokerOrders) {
      if (!localOrdersByClientId.has(broker.client_order_id))
        discrepancies.push({
          code: 'EXTERNAL_BROKER_ORDER',
          classification: 'BLOCKING',
          entityId: broker.id,
          brokerValue: broker.status,
          detail: `Unowned broker order ${broker.client_order_id}`,
        });
    }

    const localPositions = new Map(
      input.localPositions.map((position) => [position.symbol, position]),
    );
    const brokerPositions = new Map(
      input.brokerPositions.map((position) => [position.symbol, position]),
    );
    for (const [symbol, broker] of brokerPositions) {
      const local = localPositions.get(symbol);
      if (local === undefined)
        discrepancies.push({
          code: 'UNEXPECTED_POSITION',
          classification: 'BLOCKING',
          entityId: symbol,
          brokerValue: broker.qty,
          detail: 'Broker position has no local binding',
        });
      else {
        if (mismatch(local.quantity, broker.qty, input.quantityTolerance))
          discrepancies.push({
            code: 'POSITION_QUANTITY_MISMATCH',
            classification: 'BLOCKING',
            entityId: symbol,
            localValue: local.quantity,
            brokerValue: broker.qty,
            detail: 'Position quantities differ',
          });
        if (mismatch(local.averageEntryPrice, broker.avg_entry_price, input.moneyTolerance))
          discrepancies.push({
            code: 'POSITION_AVERAGE_ENTRY_PRICE_MISMATCH',
            classification: 'BLOCKING',
            entityId: symbol,
            localValue: local.averageEntryPrice,
            brokerValue: broker.avg_entry_price,
            detail: 'Average entry prices differ',
          });
      }
    }
    for (const [symbol, local] of localPositions)
      if (!brokerPositions.has(symbol))
        discrepancies.push({
          code: 'MISSING_POSITION',
          classification: 'BLOCKING',
          entityId: symbol,
          localValue: local.quantity,
          detail: 'Local position is absent from broker',
        });

    const localFillIds = new Set(input.localFills.map((fill) => fill.id));
    for (const fill of input.brokerFills.filter((activity) => activity.activity_type === 'FILL')) {
      if (!localFillIds.has(fill.id))
        discrepancies.push({
          code: 'BROKER_FILL_MISSING_LOCALLY',
          classification: 'BLOCKING',
          entityId: fill.id,
          ...(fill.qty === undefined ? {} : { brokerValue: fill.qty }),
          detail: 'Broker fill is not present in the local ledger',
        });
    }
    compareAccount(
      discrepancies,
      'CASH_MISMATCH',
      input.localAccount.cash,
      input.brokerAccount.cash,
      input.moneyTolerance,
    );
    compareAccount(
      discrepancies,
      'EQUITY_MISMATCH',
      input.localAccount.equity,
      input.brokerAccount.equity,
      input.moneyTolerance,
    );
    compareAccount(
      discrepancies,
      'BUYING_POWER_MISMATCH',
      input.localAccount.buyingPower,
      input.brokerAccount.buying_power,
      input.moneyTolerance,
    );
    const result: ReconciliationResult = {
      id,
      trigger: input.trigger,
      startedAt,
      finishedAt: this.now(),
      discrepancies,
      safeCorrectionsApplied,
      blocked: discrepancies.some((item) => item.classification === 'BLOCKING'),
    };
    await this.dependencies.persist(result);
    if (result.blocked) await this.dependencies.blockSafety(result);
    return result;
  }
}

function compareAccount(
  target: ReconciliationDiscrepancy[],
  code: 'CASH_MISMATCH' | 'EQUITY_MISMATCH' | 'BUYING_POWER_MISMATCH',
  local: string,
  broker: string,
  tolerance: string,
): void {
  if (mismatch(local, broker, tolerance))
    target.push({
      code,
      classification: 'BLOCKING',
      entityId: 'account',
      localValue: local,
      brokerValue: broker,
      detail: 'Local and broker account totals differ beyond tolerance',
    });
}

function isMonotonicTerminalCorrection(local: OrderState, broker: OrderState): boolean {
  return (
    ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'UNKNOWN'].includes(local) &&
    ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED'].includes(broker)
  );
}
