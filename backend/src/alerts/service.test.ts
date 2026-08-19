import { describe, expect, it, vi } from 'vitest';
import { AlertService, type Alert } from './service.js';

describe('AlertService', () => {
  it('falls back to email, deduplicates, throttles, and escalates recurring alerts', async () => {
    const alerts = new Map<string, Alert>();
    const repository = {
      findActiveByFingerprint: async (fingerprint: string) => alerts.get(fingerprint),
      save: async (alert: Alert) => {
        alerts.set(alert.fingerprint, alert);
      },
      listDue: async (now: Date, limit: number) =>
        [...alerts.values()]
          .filter(
            (alert) => ['PENDING', 'FAILED'].includes(alert.state) && alert.nextDeliveryAt <= now,
          )
          .slice(0, limit),
      listResolved: async () =>
        [...alerts.values()].filter((alert) => alert.state === 'ACKNOWLEDGED'),
    };
    const telegram = {
      name: 'telegram',
      send: vi.fn(async () => Promise.reject(new Error('down'))),
    };
    const email = { name: 'email', send: vi.fn(async () => undefined) };
    const service = new AlertService(
      repository,
      telegram,
      email,
      {
        throttleMs: 60_000,
        maximumDeliveryAttempts: 3,
        retryBaseMs: 1_000,
        escalateAfterOccurrences: 2,
      },
      () => 'alert',
    );
    const first = await service.raise({
      kind: 'ORDER_UNKNOWN',
      severity: 'WARNING',
      title: 'Unknown order',
      message: 'Reconciliation required',
      component: 'executor',
      deduplicationScope: 'client-order',
      occurredAt: new Date('2026-08-18T14:00:00Z'),
    });
    const second = await service.raise({
      kind: 'ORDER_UNKNOWN',
      severity: 'WARNING',
      title: 'Unknown order',
      message: 'Still unresolved',
      component: 'executor',
      deduplicationScope: 'client-order',
      occurredAt: new Date('2026-08-18T14:00:30Z'),
    });
    expect(first.state).toBe('SENT');
    expect(second.id).toBe(first.id);
    expect(second.severity).toBe('CRITICAL');
    expect(second.occurrences).toBe(2);
    expect(telegram.send).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledOnce();
  });
});
