import type { ReconciliationTrigger } from '../reconciliation/service.js';

export interface RuntimeActionContext {
  readonly actor: string;
  readonly correlationId: string;
}

export interface OperationsRuntime {
  start(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
  scannerRun(context: RuntimeActionContext): Promise<unknown>;
  closePosition(positionId: string, context: RuntimeActionContext): Promise<unknown>;
  cancelOrder(orderId: string, context: RuntimeActionContext): Promise<unknown>;
  editRisk(configuration: unknown, context: RuntimeActionContext): Promise<unknown>;
  recoverSafety(
    input: { readonly blockId?: string; readonly checks?: Readonly<Record<string, boolean>> },
    context: RuntimeActionContext,
  ): Promise<unknown>;
  killSwitch(context: RuntimeActionContext): Promise<void>;
  disableEntries(context: RuntimeActionContext): Promise<void>;
  schedulerStart(context: RuntimeActionContext): Promise<void>;
  schedulerPause(context: RuntimeActionContext): Promise<void>;
  schedulerResume(context: RuntimeActionContext): Promise<void>;
  schedulerStop(context: RuntimeActionContext): Promise<void>;
  reconcile(trigger: ReconciliationTrigger, correlationId: string): Promise<unknown>;
  activateLive(context: RuntimeActionContext): Promise<void>;
  startBacktest(
    input: {
      readonly symbol: string;
      readonly strategyId: string;
      readonly from?: string;
      readonly to?: string;
      readonly initialCapital?: number;
    },
    context: RuntimeActionContext,
  ): Promise<unknown>;
  cancelBacktest(jobId: string, context: RuntimeActionContext): Promise<unknown>;
  getBacktestJob(jobId: string): Promise<unknown>;
  updateWatchlist(symbol: string, active: boolean, context: RuntimeActionContext): Promise<unknown>;
  acknowledgeAlert(alertId: string, context: RuntimeActionContext): Promise<unknown>;
}
