import { randomUUID } from 'node:crypto';

export type SchedulerState = 'STOPPED' | 'RUNNING' | 'PAUSED' | 'BLOCKED';

export interface SchedulerConfiguration {
  readonly id: string;
  readonly intervalMs: number;
  readonly maximumDriftMs: number;
  readonly lockTtlMs: number;
  readonly enabled: boolean;
}

export interface SchedulerSnapshot {
  readonly state: SchedulerState;
  readonly configuration: SchedulerConfiguration;
  readonly nextExecutionAt?: Date;
  readonly lastExecutionAt?: Date;
  readonly activeExecutionId?: string;
}

export interface SchedulerExecution {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly trigger: 'SCHEDULED' | 'MANUAL';
  readonly scheduledFor: Date;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly result: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  readonly error?: string;
}

export interface SchedulerDependencies {
  readonly acquireLock: (executionId: string, ttlMs: number) => Promise<boolean>;
  readonly releaseLock: (executionId: string) => Promise<void>;
  readonly safetyAllowsOperation: () => boolean;
  readonly runPipeline: (executionId: string, idempotencyKey: string) => Promise<void>;
  readonly saveState: (snapshot: SchedulerSnapshot) => Promise<void>;
  readonly saveExecution: (execution: SchedulerExecution) => Promise<void>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export class SchedulerService {
  private snapshotValue: SchedulerSnapshot;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(
    configuration: SchedulerConfiguration,
    private readonly dependencies: SchedulerDependencies,
    recovered?: SchedulerSnapshot,
  ) {
    if (configuration.intervalMs <= 0 || configuration.lockTtlMs <= configuration.intervalMs)
      throw new Error('Invalid scheduler interval or lease TTL');
    this.now = dependencies.now ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
    this.snapshotValue = recovered ?? { state: 'STOPPED', configuration };
  }

  public snapshot(): SchedulerSnapshot {
    return { ...this.snapshotValue };
  }

  public async start(at = this.now()): Promise<void> {
    this.snapshotValue = {
      ...this.snapshotValue,
      state: 'RUNNING',
      nextExecutionAt: new Date(at.getTime() + this.snapshotValue.configuration.intervalMs),
    };
    await this.dependencies.saveState(this.snapshot());
  }

  public async stop(): Promise<void> {
    const base = { ...this.snapshotValue };
    delete base.nextExecutionAt;
    delete base.activeExecutionId;
    this.snapshotValue = { ...base, state: 'STOPPED' };
    await this.dependencies.saveState(this.snapshot());
  }

  public async pause(): Promise<void> {
    this.snapshotValue = { ...this.snapshotValue, state: 'PAUSED' };
    await this.dependencies.saveState(this.snapshot());
  }

  public async resume(at = this.now()): Promise<void> {
    if (this.snapshotValue.state !== 'PAUSED' && this.snapshotValue.state !== 'BLOCKED')
      throw new Error('Scheduler is not paused or blocked');
    await this.start(at);
  }

  public async recoverAfterRestart(at = this.now()): Promise<void> {
    const base = { ...this.snapshotValue };
    delete base.activeExecutionId;
    this.snapshotValue = {
      ...base,
      ...(base.state === 'RUNNING'
        ? { nextExecutionAt: new Date(at.getTime() + base.configuration.intervalMs) }
        : {}),
    };
    await this.dependencies.saveState(this.snapshot());
  }

  public async tick(trigger: 'SCHEDULED' | 'MANUAL' = 'SCHEDULED'): Promise<SchedulerExecution> {
    const startedAt = this.now();
    const scheduledFor = this.snapshotValue.nextExecutionAt ?? startedAt;
    const executionId = this.idFactory();
    const idempotencyKey = `${trigger}:${scheduledFor.toISOString()}`;
    if (
      (trigger === 'SCHEDULED' && this.snapshotValue.state !== 'RUNNING') ||
      this.snapshotValue.activeExecutionId !== undefined
    )
      return this.recordSkipped(
        executionId,
        idempotencyKey,
        trigger,
        scheduledFor,
        startedAt,
        'Scheduler inactive or overlapping',
      );
    if (!this.dependencies.safetyAllowsOperation()) {
      this.snapshotValue = { ...this.snapshotValue, state: 'BLOCKED' };
      await this.dependencies.saveState(this.snapshot());
      return this.recordSkipped(
        executionId,
        idempotencyKey,
        trigger,
        scheduledFor,
        startedAt,
        'Operational safety blocked',
      );
    }
    if (
      !(await this.dependencies.acquireLock(
        executionId,
        this.snapshotValue.configuration.lockTtlMs,
      ))
    )
      return this.recordSkipped(
        executionId,
        idempotencyKey,
        trigger,
        scheduledFor,
        startedAt,
        'Scheduler lease unavailable',
      );
    this.snapshotValue = { ...this.snapshotValue, activeExecutionId: executionId };
    await this.dependencies.saveState(this.snapshot());
    try {
      if (
        trigger === 'SCHEDULED' &&
        startedAt.getTime() - scheduledFor.getTime() >
          this.snapshotValue.configuration.maximumDriftMs
      )
        return await this.recordSkipped(
          executionId,
          idempotencyKey,
          trigger,
          scheduledFor,
          startedAt,
          'Clock drift exceeded',
        );
      await this.dependencies.runPipeline(executionId, idempotencyKey);
      return await this.complete(
        executionId,
        idempotencyKey,
        trigger,
        scheduledFor,
        startedAt,
        'COMPLETED',
      );
    } catch (error) {
      return await this.complete(
        executionId,
        idempotencyKey,
        trigger,
        scheduledFor,
        startedAt,
        'FAILED',
        error instanceof Error ? error.message : 'Unknown scheduler error',
      );
    } finally {
      await this.dependencies.releaseLock(executionId);
      const now = this.now();
      const base = { ...this.snapshotValue };
      delete base.activeExecutionId;
      this.snapshotValue = {
        ...base,
        lastExecutionAt: now,
        ...(this.snapshotValue.state === 'RUNNING'
          ? {
              // Explicit no-catch-up policy: a late/failed run never causes a burst of old runs.
              nextExecutionAt: new Date(
                now.getTime() + this.snapshotValue.configuration.intervalMs,
              ),
            }
          : {}),
      };
      await this.dependencies.saveState(this.snapshot());
    }
  }

  private async recordSkipped(
    id: string,
    idempotencyKey: string,
    trigger: SchedulerExecution['trigger'],
    scheduledFor: Date,
    startedAt: Date,
    error: string,
  ): Promise<SchedulerExecution> {
    return this.complete(id, idempotencyKey, trigger, scheduledFor, startedAt, 'SKIPPED', error);
  }

  private async complete(
    id: string,
    idempotencyKey: string,
    trigger: SchedulerExecution['trigger'],
    scheduledFor: Date,
    startedAt: Date,
    result: SchedulerExecution['result'],
    error?: string,
  ): Promise<SchedulerExecution> {
    const finishedAt = this.now();
    const execution: SchedulerExecution = {
      id,
      idempotencyKey,
      trigger,
      scheduledFor,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      result,
      ...(error === undefined ? {} : { error }),
    };
    await this.dependencies.saveExecution(execution);
    return execution;
  }
}
