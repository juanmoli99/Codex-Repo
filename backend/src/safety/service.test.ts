import { describe, expect, it, vi } from 'vitest';
import { OperationalSafetyService } from './service.js';

describe('OperationalSafetyService', () => {
  it('keeps exits available while a global entry block is active and audits recovery', async () => {
    const appendAudit = vi.fn(async () => undefined);
    const service = new OperationalSafetyService(
      'PAPER',
      { saveState: vi.fn(async () => undefined), appendAudit },
      (() => {
        let id = 0;
        return () => `id-${(id += 1)}`;
      })(),
    );
    const at = new Date('2026-08-18T14:00:00Z');
    const block = await service.block({
      scope: 'GLOBAL',
      reason: 'INVALID_MARKET_DATA',
      detail: 'Feed is stale',
      at,
      cooldownMs: 60_000,
    });
    expect(service.canEnter({ expectedMode: 'PAPER', strategyId: 'trend', symbol: 'AAPL' })).toBe(
      false,
    );
    expect(service.canExit('PAPER')).toBe(true);
    await expect(
      service.recover({
        blockId: block.id,
        actor: 'operator',
        reason: 'too early',
        at,
        checks: { feed: true },
      }),
    ).rejects.toThrow('cooldown');
    await service.recover({
      blockId: block.id,
      actor: 'operator',
      reason: 'feed recovered',
      at: new Date(at.getTime() + 60_000),
      checks: { feed: true, reconciliation: true },
    });
    await service.activate({
      actor: 'operator',
      reason: 'controlled restart',
      at: new Date(at.getTime() + 61_000),
    });
    expect(service.canEnter({ expectedMode: 'PAPER', strategyId: 'trend', symbol: 'AAPL' })).toBe(
      true,
    );
    expect(appendAudit).toHaveBeenCalledTimes(3);
  });

  it('makes emergency stop disable both entries and exits', async () => {
    const service = new OperationalSafetyService('PAPER');
    await service.emergencyStop('operator', 'broker state cannot be trusted', new Date());
    expect(service.snapshot().mode).toBe('EMERGENCY_STOP');
    expect(service.canExit('PAPER')).toBe(false);
  });
});
