import type { OrderState } from '../execution/order-state-machine.js';
import type { ReconciliationResult } from '../reconciliation/service.js';

export interface RecoverySnapshot {
  readonly orders: readonly { id: string; clientOrderId: string; state: OrderState }[];
  readonly signals: readonly { id: string; expiresAt: Date; active: boolean }[];
  readonly incompleteExecutions: readonly string[];
  readonly openBrokerOrderIds: readonly string[];
  readonly partiallyFilledOrderIds: readonly string[];
  readonly safetyStateRecovered: boolean;
  readonly schedulerStateRecovered: boolean;
  readonly activeRiskConfigurationRecovered: boolean;
  readonly staleLockNames: readonly string[];
}

export interface RecoveryAction {
  readonly type:
    | 'RECONCILE_ORDER'
    | 'INVALIDATE_SIGNAL'
    | 'RELEASE_STALE_LOCK'
    | 'RECONCILE_ALL'
    | 'MANUAL_REVIEW';
  readonly entityId: string;
  readonly detail: string;
}

export interface RecoveryPlan {
  readonly mode: 'READY' | 'DEGRADED' | 'BLOCKED';
  readonly actions: readonly RecoveryAction[];
  readonly automaticResumeAllowed: boolean;
  readonly oldOrdersMayBeResubmitted: false;
}

export class RecoveryCoordinator {
  public plan(snapshot: RecoverySnapshot, now: Date): RecoveryPlan {
    const actions: RecoveryAction[] = [];
    for (const order of snapshot.orders)
      if (['SUBMITTING', 'UNKNOWN'].includes(order.state))
        actions.push({
          type: 'RECONCILE_ORDER',
          entityId: order.id,
          detail: `Resolve ${order.state} by client order ID ${order.clientOrderId}; never resubmit`,
        });
    for (const signal of snapshot.signals)
      if (signal.active && signal.expiresAt.getTime() <= now.getTime())
        actions.push({
          type: 'INVALIDATE_SIGNAL',
          entityId: signal.id,
          detail: 'Signal expired while the system was offline',
        });
    for (const lock of snapshot.staleLockNames)
      actions.push({
        type: 'RELEASE_STALE_LOCK',
        entityId: lock,
        detail: 'Lease owner is no longer active',
      });
    if (
      snapshot.openBrokerOrderIds.length > 0 ||
      snapshot.partiallyFilledOrderIds.length > 0 ||
      snapshot.incompleteExecutions.length > 0
    )
      actions.push({
        type: 'RECONCILE_ALL',
        entityId: 'startup',
        detail: 'Rebuild open order, fill, position, account, and protection state before resume',
      });
    const baseRecovered =
      snapshot.safetyStateRecovered &&
      snapshot.schedulerStateRecovered &&
      snapshot.activeRiskConfigurationRecovered;
    if (!baseRecovered)
      actions.push({
        type: 'MANUAL_REVIEW',
        entityId: 'configuration',
        detail: 'Persistent safety, scheduler, or risk configuration could not be recovered',
      });
    const ambiguous = actions.some((action) =>
      ['RECONCILE_ORDER', 'RECONCILE_ALL', 'MANUAL_REVIEW'].includes(action.type),
    );
    return {
      mode: !baseRecovered ? 'BLOCKED' : ambiguous ? 'DEGRADED' : 'READY',
      actions,
      automaticResumeAllowed: baseRecovered && !ambiguous,
      oldOrdersMayBeResubmitted: false,
    };
  }

  public canResumeAfterReconciliation(result: ReconciliationResult): boolean {
    return (
      !result.blocked &&
      result.discrepancies.every((item) => item.classification !== 'REVIEW_REQUIRED')
    );
  }
}
