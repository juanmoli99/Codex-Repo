import type { TradingMode } from '@aegis/shared';
import type { OperationalSafetyService, SafetyState } from '../safety/service.js';

export interface RemoteOperationalSnapshot {
  readonly tradingStatus: string;
  readonly mode: TradingMode;
  readonly pnl: Readonly<Record<string, string>>;
  readonly openPositions: readonly Readonly<Record<string, unknown>>[];
  readonly openOrders: readonly Readonly<Record<string, unknown>>[];
  readonly safety: SafetyState;
}

export interface RemoteOperationAudit {
  readonly id: string;
  readonly actor: string;
  readonly channel: string;
  readonly action: string;
  readonly reason: string;
  readonly occurredAt: Date;
  readonly outcome: 'SUCCEEDED' | 'REJECTED' | 'FAILED';
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RemoteOperationDependencies {
  readonly safety: OperationalSafetyService;
  readonly queryTradingStatus: () => Promise<string>;
  readonly queryPnl: () => Promise<Readonly<Record<string, string>>>;
  readonly queryOpenPositions: () => Promise<readonly Readonly<Record<string, unknown>>[]>;
  readonly queryOpenOrders: () => Promise<readonly Readonly<Record<string, unknown>>[]>;
  readonly pauseAutomation: () => Promise<void>;
  readonly persistAudit: (audit: RemoteOperationAudit) => Promise<void>;
  readonly authorize: (actor: string, action: string) => Promise<boolean>;
  readonly idFactory: () => string;
}

export class RemoteOperationsService {
  public constructor(private readonly dependencies: RemoteOperationDependencies) {}

  public async status(): Promise<RemoteOperationalSnapshot> {
    const safety = this.dependencies.safety.snapshot();
    const [tradingStatus, pnl, openPositions, openOrders] = await Promise.all([
      this.dependencies.queryTradingStatus(),
      this.dependencies.queryPnl(),
      this.dependencies.queryOpenPositions(),
      this.dependencies.queryOpenOrders(),
    ]);
    return {
      tradingStatus,
      mode: safety.tradingMode,
      pnl,
      openPositions,
      openOrders,
      safety,
    };
  }

  public async execute(input: {
    action: 'KILL_SWITCH' | 'DISABLE_ENTRIES' | 'PAUSE_AUTOMATION';
    actor: string;
    channel: string;
    reason: string;
    at: Date;
  }): Promise<void> {
    if (!(await this.dependencies.authorize(input.actor, input.action))) {
      await this.audit(input, 'REJECTED', { code: 'REMOTE_ACTION_UNAUTHORIZED' });
      throw new Error('REMOTE_ACTION_UNAUTHORIZED');
    }
    try {
      switch (input.action) {
        case 'KILL_SWITCH':
          await this.dependencies.safety.killSwitch(input.actor, input.reason, input.at);
          break;
        case 'DISABLE_ENTRIES':
          await this.dependencies.safety.disableEntries(input.actor, input.reason, input.at);
          break;
        case 'PAUSE_AUTOMATION':
          await this.dependencies.pauseAutomation();
          break;
      }
      await this.audit(input, 'SUCCEEDED', {
        safetyVersion: this.dependencies.safety.snapshot().version,
      });
    } catch (error) {
      await this.audit(input, 'FAILED', {
        error: error instanceof Error ? error.message : 'Remote operation failed',
      });
      throw error;
    }
  }

  private async audit(
    input: {
      action: string;
      actor: string;
      channel: string;
      reason: string;
      at: Date;
    },
    outcome: RemoteOperationAudit['outcome'],
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.dependencies.persistAudit({
      id: this.dependencies.idFactory(),
      actor: input.actor,
      channel: input.channel,
      action: input.action,
      reason: input.reason,
      occurredAt: new Date(input.at),
      outcome,
      metadata,
    });
  }
}

export interface RemoteMessage {
  readonly actor: string;
  readonly channel: string;
  readonly command: string;
  readonly reason: string;
  readonly receivedAt: Date;
}

export class RemoteMessageRouter {
  public constructor(private readonly operations: RemoteOperationsService) {}

  public async handle(message: RemoteMessage): Promise<RemoteOperationalSnapshot | { ok: true }> {
    const command = message.command.trim().toLowerCase();
    if (
      command === 'status' ||
      command === 'pnl' ||
      command === 'positions' ||
      command === 'orders'
    )
      return this.operations.status();
    const action =
      command === 'kill'
        ? 'KILL_SWITCH'
        : command === 'disable entries'
          ? 'DISABLE_ENTRIES'
          : command === 'pause'
            ? 'PAUSE_AUTOMATION'
            : undefined;
    if (action === undefined) throw new Error('UNKNOWN_REMOTE_COMMAND');
    await this.operations.execute({
      action,
      actor: message.actor,
      channel: message.channel,
      reason: message.reason,
      at: message.receivedAt,
    });
    return { ok: true };
  }
}
