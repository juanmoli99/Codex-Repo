import { randomUUID } from 'node:crypto';

import type { StrategyDefinition } from '../strategies/types.js';

export type StrategyDeploymentState =
  'PLANNED' | 'DRAINING' | 'DEPLOYED' | 'RECONCILING' | 'COMPLETED' | 'ROLLED_BACK' | 'FAILED';

export interface OpenStrategyPosition {
  readonly id: string;
  readonly symbol: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly protectionType: string;
}

export interface StrategyDeploymentRecord {
  readonly id: string;
  readonly strategyId: string;
  readonly fromVersion?: string;
  readonly toVersion: string;
  readonly deploymentId: string;
  readonly state: StrategyDeploymentState;
  readonly actor: string;
  readonly reason: string;
  readonly schedulerStateBefore: string;
  readonly entriesEnabledBefore: boolean;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly failure?: string;
}

export interface StrategyDeploymentDependencies {
  readonly acquireDeploymentLock: (deploymentId: string) => Promise<boolean>;
  readonly releaseDeploymentLock: (deploymentId: string) => Promise<void>;
  readonly disableNewEntries: (deploymentId: string) => Promise<void>;
  readonly restoreEntryState: (enabled: boolean, deploymentId: string) => Promise<void>;
  readonly getEntryState: () => Promise<boolean>;
  readonly getSchedulerState: () => Promise<string>;
  readonly listOpenPositions: (strategyId: string) => Promise<readonly OpenStrategyPosition[]>;
  readonly listAvailableVersions: (strategyId: string) => Promise<readonly string[]>;
  readonly waitForInFlightExecutions: (timeoutMs: number) => Promise<boolean>;
  readonly validateProtectionCompatibility: (
    definition: StrategyDefinition,
    positions: readonly OpenStrategyPosition[],
  ) => Promise<readonly string[]>;
  readonly activateVersion: (
    definition: StrategyDefinition,
    previousVersion: string | undefined,
  ) => Promise<void>;
  readonly rollbackVersion: (
    strategyId: string,
    failedVersion: string,
    previousVersion: string | undefined,
  ) => Promise<void>;
  readonly reconcileAfterDeployment: (deploymentId: string) => Promise<boolean>;
  readonly persist: (record: StrategyDeploymentRecord) => Promise<void>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export class StrategyDeployer {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(private readonly dependencies: StrategyDeploymentDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async deploy(input: {
    definition: StrategyDefinition;
    previousVersion?: string;
    actor: string;
    reason: string;
    drainTimeoutMs: number;
  }): Promise<StrategyDeploymentRecord> {
    const deploymentId = input.definition.deploymentId;
    const id = this.idFactory();
    if (!(await this.dependencies.acquireDeploymentLock(deploymentId)))
      throw new Error('STRATEGY_DEPLOYMENT_LOCK_UNAVAILABLE');
    const entriesEnabledBefore = await this.dependencies.getEntryState();
    const schedulerStateBefore = await this.dependencies.getSchedulerState();
    let record: StrategyDeploymentRecord = {
      id,
      strategyId: input.definition.id,
      ...(input.previousVersion === undefined ? {} : { fromVersion: input.previousVersion }),
      toVersion: input.definition.version,
      deploymentId,
      state: 'PLANNED',
      actor: input.actor,
      reason: input.reason,
      schedulerStateBefore,
      entriesEnabledBefore,
      startedAt: this.now(),
    };
    await this.dependencies.persist(record);
    try {
      await this.dependencies.disableNewEntries(deploymentId);
      record = { ...record, state: 'DRAINING' };
      await this.dependencies.persist(record);
      if (!(await this.dependencies.waitForInFlightExecutions(input.drainTimeoutMs)))
        throw new Error('IN_FLIGHT_EXECUTIONS_DID_NOT_DRAIN');
      const positions = await this.dependencies.listOpenPositions(input.definition.id);
      const versions = await this.dependencies.listAvailableVersions(input.definition.id);
      const missingVersions = positions
        .map((position) => position.strategyVersion)
        .filter((version) => !versions.includes(version));
      if (missingVersions.length > 0)
        throw new Error(
          `OPEN_POSITION_VERSION_UNAVAILABLE:${[...new Set(missingVersions)].join(',')}`,
        );
      const compatibilityErrors = await this.dependencies.validateProtectionCompatibility(
        input.definition,
        positions,
      );
      if (compatibilityErrors.length > 0)
        throw new Error(`PROTECTION_COMPATIBILITY_FAILED:${compatibilityErrors.join(',')}`);
      await this.dependencies.activateVersion(input.definition, input.previousVersion);
      record = { ...record, state: 'DEPLOYED' };
      await this.dependencies.persist(record);
      record = { ...record, state: 'RECONCILING' };
      await this.dependencies.persist(record);
      if (!(await this.dependencies.reconcileAfterDeployment(deploymentId)))
        throw new Error('POST_DEPLOYMENT_RECONCILIATION_FAILED');
      await this.dependencies.restoreEntryState(entriesEnabledBefore, deploymentId);
      record = { ...record, state: 'COMPLETED', finishedAt: this.now() };
      await this.dependencies.persist(record);
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Strategy deployment failed';
      if (['DEPLOYED', 'RECONCILING'].includes(record.state)) {
        await this.dependencies.rollbackVersion(
          input.definition.id,
          input.definition.version,
          input.previousVersion,
        );
        record = {
          ...record,
          state: 'ROLLED_BACK',
          failure: message,
          finishedAt: this.now(),
        };
      } else {
        record = { ...record, state: 'FAILED', failure: message, finishedAt: this.now() };
      }
      await this.dependencies.persist(record);
      return record;
    } finally {
      await this.dependencies.releaseDeploymentLock(deploymentId);
    }
  }
}
