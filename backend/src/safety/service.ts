import { randomUUID } from 'node:crypto';
import type { TradingMode } from '@aegis/shared';

export type SafetyMode = 'NORMAL' | 'ONLY_CLOSE' | 'KILL_SWITCH' | 'EMERGENCY_STOP';
export type SafetyScope = 'GLOBAL' | 'STRATEGY' | 'SYMBOL' | 'EXECUTOR' | 'ORDER_REJECTIONS';

export type SafetyBlockReason =
  | 'DAILY_LOSS'
  | 'DRAWDOWN'
  | 'INVALID_MARKET_DATA'
  | 'BROKER_DISCONNECTED'
  | 'RECONCILIATION_FAILED'
  | 'UNEXPECTED_POSITION'
  | 'UNKNOWN_ORDER'
  | 'INVALID_CONFIGURATION'
  | 'CONSECUTIVE_ERRORS'
  | 'REJECTED_ORDERS'
  | 'MANUAL';

export interface SafetyBlock {
  readonly id: string;
  readonly scope: SafetyScope;
  readonly scopeId?: string;
  readonly reason: SafetyBlockReason;
  readonly detail: string;
  readonly blockedAt: Date;
  readonly cooldownUntil: Date;
  readonly manualOverride: boolean;
}

export interface SafetyState {
  readonly version: number;
  readonly tradingMode: TradingMode;
  readonly mode: SafetyMode;
  readonly tradingEnabled: boolean;
  readonly entriesEnabled: boolean;
  readonly exitsAllowed: boolean;
  readonly globalLockOwner?: string;
  readonly blocks: readonly SafetyBlock[];
  readonly lastChangedAt: Date;
}

export interface SafetyAuditEvent {
  readonly id: string;
  readonly action: string;
  readonly actor: string;
  readonly reason: string;
  readonly before: SafetyState;
  readonly after: SafetyState;
  readonly occurredAt: Date;
}

export interface SafetyRepository {
  saveState(state: SafetyState): Promise<void>;
  appendAudit(event: SafetyAuditEvent): Promise<void>;
}

function clone(state: SafetyState): SafetyState {
  return { ...state, blocks: [...state.blocks], lastChangedAt: new Date(state.lastChangedAt) };
}

export class OperationalSafetyService {
  private state: SafetyState;

  public constructor(
    tradingMode: TradingMode,
    private readonly repository?: SafetyRepository,
    private readonly idFactory: () => string = randomUUID,
    recovered?: SafetyState,
  ) {
    this.state = recovered
      ? clone(recovered)
      : {
          version: 0,
          tradingMode,
          mode: 'ONLY_CLOSE',
          tradingEnabled: false,
          entriesEnabled: false,
          exitsAllowed: true,
          blocks: [],
          lastChangedAt: new Date(0),
        };
  }

  public snapshot(): SafetyState {
    return clone(this.state);
  }

  public canEnter(input: {
    expectedMode: TradingMode;
    strategyId: string;
    symbol: string;
  }): boolean {
    return (
      input.expectedMode === this.state.tradingMode &&
      this.state.mode === 'NORMAL' &&
      this.state.tradingEnabled &&
      this.state.entriesEnabled &&
      this.state.globalLockOwner === undefined &&
      !this.hasBlock('GLOBAL') &&
      !this.hasBlock('STRATEGY', input.strategyId) &&
      !this.hasBlock('SYMBOL', input.symbol) &&
      !this.hasBlock('EXECUTOR') &&
      !this.hasBlock('ORDER_REJECTIONS')
    );
  }

  public canExit(expectedMode: TradingMode): boolean {
    return expectedMode === this.state.tradingMode && this.state.exitsAllowed;
  }

  public async activate(input: { actor: string; reason: string; at: Date }): Promise<void> {
    if (this.state.blocks.length > 0)
      throw new Error('Cannot activate with unresolved safety blocks');
    await this.transition('ACTIVATE', input.actor, input.reason, input.at, {
      mode: 'NORMAL',
      tradingEnabled: true,
      entriesEnabled: true,
      exitsAllowed: true,
    });
  }

  public async block(input: {
    scope: SafetyScope;
    scopeId?: string;
    reason: SafetyBlockReason;
    detail: string;
    at: Date;
    cooldownMs: number;
    actor?: string;
  }): Promise<SafetyBlock> {
    const existing = this.state.blocks.find(
      (block) =>
        block.scope === input.scope &&
        block.scopeId === input.scopeId &&
        block.reason === input.reason,
    );
    if (existing !== undefined) return existing;
    const block: SafetyBlock = {
      id: this.idFactory(),
      scope: input.scope,
      ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
      reason: input.reason,
      detail: input.detail,
      blockedAt: new Date(input.at),
      cooldownUntil: new Date(input.at.getTime() + Math.max(0, input.cooldownMs)),
      manualOverride: false,
    };
    const global = input.scope === 'GLOBAL';
    await this.transition('BLOCK', input.actor ?? 'system', input.reason, input.at, {
      blocks: [...this.state.blocks, block],
      ...(global
        ? { mode: 'ONLY_CLOSE' as const, tradingEnabled: false, entriesEnabled: false }
        : {}),
    });
    return block;
  }

  public async recover(input: {
    blockId: string;
    actor: string;
    reason: string;
    at: Date;
    checks: Readonly<Record<string, boolean>>;
    manualOverride?: boolean;
  }): Promise<void> {
    const block = this.state.blocks.find((candidate) => candidate.id === input.blockId);
    if (block === undefined) throw new Error('Safety block not found');
    if (!input.manualOverride && input.at.getTime() < block.cooldownUntil.getTime())
      throw new Error('Safety cooldown is active');
    if (!input.manualOverride && Object.values(input.checks).some((passed) => !passed))
      throw new Error('Safety recovery checks failed');
    const blocks = this.state.blocks.filter((candidate) => candidate.id !== input.blockId);
    await this.transition('RECOVER', input.actor, input.reason, input.at, {
      blocks,
      ...(blocks.length === 0 && this.state.mode === 'ONLY_CLOSE'
        ? { mode: 'ONLY_CLOSE' as const, tradingEnabled: false, entriesEnabled: false }
        : {}),
    });
  }

  public async killSwitch(actor: string, reason: string, at: Date): Promise<void> {
    await this.transition('KILL_SWITCH', actor, reason, at, {
      mode: 'KILL_SWITCH',
      tradingEnabled: false,
      entriesEnabled: false,
      exitsAllowed: true,
    });
  }

  public async disableEntries(actor: string, reason: string, at: Date): Promise<void> {
    await this.transition('DISABLE_ENTRIES', actor, reason, at, {
      mode: 'ONLY_CLOSE',
      entriesEnabled: false,
      exitsAllowed: true,
    });
  }

  public async emergencyStop(actor: string, reason: string, at: Date): Promise<void> {
    await this.transition('EMERGENCY_STOP', actor, reason, at, {
      mode: 'EMERGENCY_STOP',
      tradingEnabled: false,
      entriesEnabled: false,
      exitsAllowed: false,
    });
  }

  public async acquireGlobalLock(owner: string, at: Date): Promise<void> {
    if (this.state.globalLockOwner !== undefined && this.state.globalLockOwner !== owner)
      throw new Error('Global lock is already held');
    await this.transition('GLOBAL_LOCK_ACQUIRE', owner, 'Exclusive operation', at, {
      globalLockOwner: owner,
      entriesEnabled: false,
    });
  }

  public async releaseGlobalLock(owner: string, at: Date): Promise<void> {
    if (this.state.globalLockOwner !== owner) throw new Error('Global lock owner mismatch');
    const withoutOwner = { ...this.state };
    delete withoutOwner.globalLockOwner;
    await this.replace(
      'GLOBAL_LOCK_RELEASE',
      owner,
      'Exclusive operation completed',
      at,
      withoutOwner,
    );
  }

  private hasBlock(scope: SafetyScope, scopeId?: string): boolean {
    return this.state.blocks.some(
      (block) => block.scope === scope && (scopeId === undefined || block.scopeId === scopeId),
    );
  }

  private async transition(
    action: string,
    actor: string,
    reason: string,
    at: Date,
    change: Partial<SafetyState>,
  ): Promise<void> {
    await this.replace(action, actor, reason, at, { ...this.state, ...change });
  }

  private async replace(
    action: string,
    actor: string,
    reason: string,
    at: Date,
    next: Omit<SafetyState, 'version' | 'lastChangedAt'> &
      Partial<Pick<SafetyState, 'version' | 'lastChangedAt'>>,
  ): Promise<void> {
    const before = clone(this.state);
    const after: SafetyState = {
      ...next,
      version: before.version + 1,
      lastChangedAt: new Date(at),
      blocks: [...next.blocks],
    };
    await this.repository?.saveState(after);
    await this.repository?.appendAudit({
      id: this.idFactory(),
      action,
      actor,
      reason,
      before,
      after: clone(after),
      occurredAt: new Date(at),
    });
    this.state = after;
  }
}
