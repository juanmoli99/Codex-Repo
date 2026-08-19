import { describe, expect, it } from 'vitest';
import { RecoveryCoordinator } from './coordinator.js';

describe('RecoveryCoordinator', () => {
  it('requires reconciliation for unknown work and never resubmits old orders', () => {
    const coordinator = new RecoveryCoordinator();
    const plan = coordinator.plan(
      {
        orders: [{ id: 'o', clientOrderId: 'client', state: 'UNKNOWN' }],
        signals: [{ id: 's', expiresAt: new Date('2026-08-18T13:00:00Z'), active: true }],
        incompleteExecutions: ['execution'],
        openBrokerOrderIds: ['broker'],
        partiallyFilledOrderIds: [],
        safetyStateRecovered: true,
        schedulerStateRecovered: true,
        activeRiskConfigurationRecovered: true,
        staleLockNames: ['scheduler'],
      },
      new Date('2026-08-18T14:00:00Z'),
    );
    expect(plan.mode).toBe('DEGRADED');
    expect(plan.automaticResumeAllowed).toBe(false);
    expect(plan.oldOrdersMayBeResubmitted).toBe(false);
    expect(plan.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining(['RECONCILE_ORDER', 'INVALIDATE_SIGNAL', 'RELEASE_STALE_LOCK']),
    );
  });
});
