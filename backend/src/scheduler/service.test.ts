import { describe, expect, it, vi } from 'vitest';
import { SchedulerService } from './service.js';

describe('SchedulerService', () => {
  it('persists state and runs the integrated pipeline under a lease', async () => {
    let clock = new Date('2026-08-18T14:00:00Z');
    const runPipeline = vi.fn(async () => {
      clock = new Date(clock.getTime() + 250);
    });
    const saveExecution = vi.fn(async () => undefined);
    const scheduler = new SchedulerService(
      {
        id: 'config',
        intervalMs: 60_000,
        maximumDriftMs: 5_000,
        lockTtlMs: 120_000,
        enabled: true,
      },
      {
        acquireLock: async () => true,
        releaseLock: async () => undefined,
        safetyAllowsOperation: () => true,
        runPipeline,
        saveState: async () => undefined,
        saveExecution,
        now: () => clock,
        idFactory: () => 'execution',
      },
    );
    await scheduler.start(new Date(clock.getTime() - 60_000));
    const execution = await scheduler.tick();
    expect(execution).toMatchObject({ result: 'COMPLETED', durationMs: 250 });
    expect(runPipeline).toHaveBeenCalledWith('execution', 'SCHEDULED:2026-08-18T14:00:00.000Z');
    expect(scheduler.snapshot().activeExecutionId).toBeUndefined();
  });

  it('blocks and skips when operational safety disallows work', async () => {
    const scheduler = new SchedulerService(
      { id: 'c', intervalMs: 1_000, maximumDriftMs: 100, lockTtlMs: 2_000, enabled: true },
      {
        acquireLock: async () => true,
        releaseLock: async () => undefined,
        safetyAllowsOperation: () => false,
        runPipeline: async () => undefined,
        saveState: async () => undefined,
        saveExecution: async () => undefined,
        idFactory: () => 'e',
      },
    );
    await scheduler.start();
    expect((await scheduler.tick()).result).toBe('SKIPPED');
    expect(scheduler.snapshot().state).toBe('BLOCKED');
  });
});
