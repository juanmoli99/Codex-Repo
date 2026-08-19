import type { SystemState } from '@aegis/shared';

import { SafetyError } from './errors.js';

const allowedTransitions: Readonly<Record<SystemState, readonly SystemState[]>> = {
  READY: ['DEGRADED', 'BLOCKED', 'EMERGENCY'],
  DEGRADED: ['READY', 'BLOCKED', 'EMERGENCY'],
  BLOCKED: ['READY', 'DEGRADED', 'EMERGENCY'],
  EMERGENCY: ['BLOCKED'],
};

export interface OperationalStateSnapshot {
  readonly state: SystemState;
  readonly reasonCode: string;
  readonly reasonDetail?: string;
  readonly changedBy: string;
  readonly changedAt: Date;
  readonly version: number;
}

export type StateChangeObserver = (
  previous: OperationalStateSnapshot,
  current: OperationalStateSnapshot,
) => Promise<void> | void;

export class OperationalStateService {
  private snapshot: OperationalStateSnapshot;

  public constructor(private readonly observer?: StateChangeObserver) {
    this.snapshot = Object.freeze({
      state: 'BLOCKED',
      reasonCode: 'STARTUP_IN_PROGRESS',
      changedBy: 'system',
      changedAt: new Date(),
      version: 0,
    });
  }

  public current(): OperationalStateSnapshot {
    return this.snapshot;
  }

  public async transition(
    state: SystemState,
    reasonCode: string,
    changedBy: string,
    reasonDetail?: string,
  ): Promise<OperationalStateSnapshot> {
    if (!reasonCode.trim() || !changedBy.trim()) {
      throw new SafetyError(
        'STATE_CHANGE_CONTEXT_REQUIRED',
        'State changes require a reason and actor',
      );
    }
    const previous = this.snapshot;
    if (state !== previous.state && !allowedTransitions[previous.state].includes(state)) {
      throw new SafetyError(
        'STATE_TRANSITION_FORBIDDEN',
        `Transition ${previous.state} -> ${state} is forbidden`,
      );
    }
    const current = Object.freeze({
      state,
      reasonCode,
      ...(reasonDetail ? { reasonDetail } : {}),
      changedBy,
      changedAt: new Date(),
      version: previous.version + 1,
    });
    await this.observer?.(previous, current);
    this.snapshot = current;
    return current;
  }
}
