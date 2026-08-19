import type { Logger } from 'pino';
import type { SchedulerService } from './service.js';

export interface SchedulerWorkerDependencies {
  readonly scheduler: SchedulerService;
  readonly workerId: string;
  readonly heartbeatIntervalMs: number;
  readonly saveHeartbeat: (input: {
    workerId: string;
    status: 'STARTING' | 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED';
    leader: boolean;
    at: Date;
    detail?: string;
  }) => Promise<void>;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class SchedulerWorker {
  private timer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = true;
  private running = false;
  private readonly now: () => Date;

  public constructor(private readonly dependencies: SchedulerWorkerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.dependencies.saveHeartbeat({
      workerId: this.dependencies.workerId,
      status: 'STARTING',
      leader: false,
      at: this.now(),
    });
    await this.dependencies.scheduler.recoverAfterRestart(this.now());
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      this.dependencies.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref();
    this.wake();
  }

  public wake(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const snapshot = this.dependencies.scheduler.snapshot();
    if (snapshot.state !== 'RUNNING' || !snapshot.nextExecutionAt) return;
    const delay = Math.max(0, snapshot.nextExecutionAt.getTime() - this.now().getTime());
    this.timer = setTimeout(() => void this.runScheduled(), delay);
    this.timer.unref();
  }

  public async stop(timeoutMs = 30_000): Promise<boolean> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.dependencies.saveHeartbeat({
      workerId: this.dependencies.workerId,
      status: 'STOPPING',
      leader: this.running,
      at: this.now(),
    });
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await this.dependencies.saveHeartbeat({
      workerId: this.dependencies.workerId,
      status: this.running ? 'FAILED' : 'STOPPED',
      leader: false,
      at: this.now(),
      ...(this.running ? { detail: 'Critical operation exceeded shutdown timeout' } : {}),
    });
    return !this.running;
  }

  private async runScheduled(): Promise<void> {
    if (this.stopped || this.running || this.dependencies.scheduler.snapshot().state !== 'RUNNING')
      return;
    this.running = true;
    try {
      await this.dependencies.scheduler.tick('SCHEDULED');
    } catch (error) {
      this.dependencies.logger.error({ err: error }, 'Scheduled pipeline failed');
    } finally {
      this.running = false;
      this.wake();
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped) return;
    await this.dependencies
      .saveHeartbeat({
        workerId: this.dependencies.workerId,
        status: this.running ? 'RUNNING' : 'IDLE',
        leader: this.running,
        at: this.now(),
      })
      .catch((error: unknown) =>
        this.dependencies.logger.error({ err: error }, 'Worker heartbeat persistence failed'),
      );
  }
}
