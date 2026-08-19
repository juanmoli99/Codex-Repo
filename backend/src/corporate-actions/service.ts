import { Decimal } from 'decimal.js';

export type CorporateActionType =
  | 'FORWARD_SPLIT'
  | 'REVERSE_SPLIT'
  | 'CASH_DIVIDEND'
  | 'STOCK_DIVIDEND'
  | 'NAME_CHANGE'
  | 'SYMBOL_CHANGE'
  | 'CASH_MERGER'
  | 'STOCK_MERGER'
  | 'STOCK_AND_CASH_MERGER'
  | 'SPIN_OFF'
  | 'REDEMPTION'
  | 'DELISTING'
  | 'WORTHLESS_REMOVAL'
  | 'REORGANIZATION'
  | 'PARTIAL_CALL';

export type CorporateActionStatus =
  'PENDING' | 'EFFECTIVE' | 'RECONCILING' | 'RECONCILED' | 'AMBIGUOUS';

export interface CorporateAction {
  readonly id: string;
  readonly type: CorporateActionType;
  readonly status: CorporateActionStatus;
  readonly symbol: string;
  readonly newSymbol?: string;
  readonly effectiveAt: Date;
  readonly quantityRatio?: string;
  readonly cashAmount?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface AffectedPosition {
  readonly id: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly costBasis: string;
}

export interface AffectedOrder {
  readonly id: string;
  readonly symbol: string;
  readonly status: string;
}

export interface CorporateActionAdjustment {
  readonly actionId: string;
  readonly entityType: 'POSITION' | 'ORDER' | 'WATCHLIST' | 'STRATEGY' | 'MARKET_DATA_CACHE';
  readonly entityId: string;
  readonly operation: string;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface CorporateActionPlan {
  readonly actionId: string;
  readonly blockNewEntries: true;
  readonly invalidateMarketDataCache: true;
  readonly cancelOrReviewOrderIds: readonly string[];
  readonly positionAdjustments: readonly CorporateActionAdjustment[];
  readonly symbolReplacement?: { readonly from: string; readonly to: string };
  readonly requiresBrokerReconciliation: true;
  readonly automaticallySafe: boolean;
  readonly reason: string;
}

const AMBIGUOUS_ACTIONS = new Set<CorporateActionType>([
  'CASH_MERGER',
  'STOCK_MERGER',
  'STOCK_AND_CASH_MERGER',
  'SPIN_OFF',
  'REDEMPTION',
  'DELISTING',
  'WORTHLESS_REMOVAL',
  'REORGANIZATION',
  'PARTIAL_CALL',
]);

export class CorporateActionService {
  public plan(
    action: CorporateAction,
    positions: readonly AffectedPosition[],
    openOrders: readonly AffectedOrder[],
  ): CorporateActionPlan {
    const impactedPositions = positions.filter((position) => position.symbol === action.symbol);
    const impactedOrders = openOrders.filter((order) => order.symbol === action.symbol);
    const adjustments: CorporateActionAdjustment[] = [];
    const ratio = action.quantityRatio ? new Decimal(action.quantityRatio) : null;

    if ((action.type === 'FORWARD_SPLIT' || action.type === 'REVERSE_SPLIT') && ratio?.gt(0)) {
      for (const position of impactedPositions) {
        const before = { quantity: position.quantity, costBasis: position.costBasis };
        const after = {
          quantity: new Decimal(position.quantity).mul(ratio).toString(),
          costBasis: position.costBasis,
          perShareBasis: new Decimal(position.costBasis)
            .div(new Decimal(position.quantity).mul(ratio))
            .toString(),
        };
        adjustments.push({
          actionId: action.id,
          entityType: 'POSITION',
          entityId: position.id,
          operation: 'SPLIT_RESTATEMENT',
          before: Object.freeze(before),
          after: Object.freeze(after),
          createdAt: new Date(),
        });
      }
    }

    const symbolReplacement =
      (action.type === 'SYMBOL_CHANGE' || action.type === 'NAME_CHANGE') && action.newSymbol
        ? { from: action.symbol, to: action.newSymbol }
        : undefined;
    const automaticallySafe =
      !AMBIGUOUS_ACTIONS.has(action.type) &&
      ((action.type !== 'FORWARD_SPLIT' && action.type !== 'REVERSE_SPLIT') ||
        ratio?.gt(0) === true);

    return Object.freeze({
      actionId: action.id,
      blockNewEntries: true,
      invalidateMarketDataCache: true,
      cancelOrReviewOrderIds: Object.freeze(impactedOrders.map((order) => order.id)),
      positionAdjustments: Object.freeze(adjustments),
      ...(symbolReplacement ? { symbolReplacement: Object.freeze(symbolReplacement) } : {}),
      requiresBrokerReconciliation: true,
      automaticallySafe,
      reason: automaticallySafe
        ? 'LOCAL_ADJUSTMENT_PREPARED_PENDING_BROKER_RECONCILIATION'
        : 'AMBIGUOUS_CORPORATE_ACTION_REQUIRES_MANUAL_RECONCILIATION',
    });
  }
}
