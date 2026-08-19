import { describe, expect, it, vi } from 'vitest';
import { OperationalSafetyService } from '../safety/service.js';
import { RemoteMessageRouter, RemoteOperationsService } from './service.js';

describe('remote operations', () => {
  it('routes status and a persisted kill switch only through backend services', async () => {
    const safety = new OperationalSafetyService('PAPER');
    await safety.activate({ actor: 'test', reason: 'ready', at: new Date('2026-08-18T14:00:00Z') });
    const persistAudit = vi.fn(async () => undefined);
    const operations = new RemoteOperationsService({
      safety,
      queryTradingStatus: async () => 'READY',
      queryPnl: async () => ({ daily: '10' }),
      queryOpenPositions: async () => [{ symbol: 'AAPL' }],
      queryOpenOrders: async () => [],
      pauseAutomation: async () => undefined,
      persistAudit,
      authorize: async () => true,
      idFactory: () => 'audit',
    });
    const router = new RemoteMessageRouter(operations);
    expect(
      await router.handle({
        actor: 'operator',
        channel: 'telegram',
        command: 'status',
        reason: 'query',
        receivedAt: new Date(),
      }),
    ).toMatchObject({ tradingStatus: 'READY', mode: 'PAPER' });
    await router.handle({
      actor: 'operator',
      channel: 'telegram',
      command: 'kill',
      reason: 'manual emergency',
      receivedAt: new Date('2026-08-18T14:01:00Z'),
    });
    expect(safety.snapshot().mode).toBe('KILL_SWITCH');
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCEEDED' }));
  });

  it('rejects unauthorized remote mutations and audits them', async () => {
    const safety = new OperationalSafetyService('PAPER');
    const persistAudit = vi.fn(async () => undefined);
    const operations = new RemoteOperationsService({
      safety,
      queryTradingStatus: async () => 'BLOCKED',
      queryPnl: async () => ({}),
      queryOpenPositions: async () => [],
      queryOpenOrders: async () => [],
      pauseAutomation: async () => undefined,
      persistAudit,
      authorize: async () => false,
      idFactory: () => 'audit',
    });
    await expect(
      operations.execute({
        action: 'DISABLE_ENTRIES',
        actor: 'intruder',
        channel: 'telegram',
        reason: 'unauthorized',
        at: new Date(),
      }),
    ).rejects.toThrow('UNAUTHORIZED');
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'REJECTED' }));
  });
});
