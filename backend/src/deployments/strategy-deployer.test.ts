import { describe, expect, it, vi } from 'vitest';
import { createTrendStrategy } from '../strategies/implementations.js';
import { StrategyDeployer } from './strategy-deployer.js';

function dependencies(reconcile: boolean) {
  const persist = vi.fn(async () => undefined);
  const rollbackVersion = vi.fn(async () => undefined);
  const restoreEntryState = vi.fn(async () => undefined);
  return {
    values: { persist, rollbackVersion, restoreEntryState },
    input: {
      acquireDeploymentLock: async () => true,
      releaseDeploymentLock: async () => undefined,
      disableNewEntries: async () => undefined,
      restoreEntryState,
      getEntryState: async () => true,
      getSchedulerState: async () => 'RUNNING',
      listOpenPositions: async () => [
        {
          id: 'position',
          symbol: 'AAPL',
          strategyId: 'trend-following',
          strategyVersion: '1.0.0',
          protectionType: 'bracket',
        },
      ],
      listAvailableVersions: async () => ['1.0.0'],
      waitForInFlightExecutions: async () => true,
      validateProtectionCompatibility: async () => [],
      activateVersion: async () => undefined,
      rollbackVersion,
      reconcileAfterDeployment: async () => reconcile,
      persist,
      now: () => new Date('2026-08-18T15:00:00Z'),
      idFactory: () => 'deployment-record',
    },
  };
}

describe('StrategyDeployer', () => {
  it('preserves open versions and scheduler state while completing post-deploy reconciliation', async () => {
    const setup = dependencies(true);
    const deployer = new StrategyDeployer(setup.input);
    const result = await deployer.deploy({
      definition: createTrendStrategy({
        version: '2.0.0',
        configurationVersion: '2',
        deploymentId: 'deployment-2',
      }),
      previousVersion: '1.0.0',
      actor: 'operator',
      reason: 'validated release',
      drainTimeoutMs: 30_000,
    });
    expect(result).toMatchObject({ state: 'COMPLETED', schedulerStateBefore: 'RUNNING' });
    expect(setup.values.restoreEntryState).toHaveBeenCalledWith(true, 'deployment-2');
    expect(setup.values.rollbackVersion).not.toHaveBeenCalled();
  });

  it('rolls back a deployed version and keeps entries blocked when reconciliation fails', async () => {
    const setup = dependencies(false);
    const deployer = new StrategyDeployer(setup.input);
    const result = await deployer.deploy({
      definition: createTrendStrategy({
        version: '2.0.0',
        configurationVersion: '2',
        deploymentId: 'deployment-2',
      }),
      previousVersion: '1.0.0',
      actor: 'operator',
      reason: 'validated release',
      drainTimeoutMs: 30_000,
    });
    expect(result.state).toBe('ROLLED_BACK');
    expect(setup.values.rollbackVersion).toHaveBeenCalledWith('trend-following', '2.0.0', '1.0.0');
    expect(setup.values.restoreEntryState).not.toHaveBeenCalled();
  });
});
