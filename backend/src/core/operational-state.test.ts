import { describe, expect, it, vi } from 'vitest';

import { SafetyError } from './errors.js';
import { OperationalStateService } from './operational-state.js';

describe('OperationalStateService', () => {
  it('starts blocked and audits transitions before publishing them', async () => {
    const observer = vi.fn();
    const service = new OperationalStateService(observer);
    expect(service.current().state).toBe('BLOCKED');

    const current = await service.transition('READY', 'STARTUP_COMPLETE', 'system');
    expect(current.state).toBe('READY');
    expect(current.version).toBe(1);
    expect(observer).toHaveBeenCalledOnce();
  });

  it('requires EMERGENCY to recover through BLOCKED', async () => {
    const service = new OperationalStateService();
    await service.transition('EMERGENCY', 'KILL_SWITCH', 'operator');
    await expect(service.transition('READY', 'MANUAL_RECOVERY', 'operator')).rejects.toBeInstanceOf(
      SafetyError,
    );
    await service.transition('BLOCKED', 'RECOVERY_RECONCILIATION', 'operator');
    await service.transition('READY', 'RECOVERY_VERIFIED', 'operator');
    expect(service.current().state).toBe('READY');
  });
});
