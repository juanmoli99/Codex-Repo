import { describe, expect, it, vi } from 'vitest';
import { HealthMonitor } from './health.js';
import { MetricRegistry, TradingMetrics } from './metrics.js';

describe('observability', () => {
  it('records required metrics and exports labels safely', () => {
    const registry = new MetricRegistry();
    const metrics = new TradingMetrics(registry);
    metrics.order('unknown');
    metrics.alpacaLatency(100);
    metrics.alpacaLatency(200);
    metrics.lastSuccess('reconciliation', new Date('2026-08-18T14:00:00Z'));
    expect(registry.value('aegis_orders_total', { state: 'unknown' })).toBe(1);
    expect(registry.summary('aegis_alpaca_latency_ms')).toMatchObject({ count: 2, average: 150 });
    expect(registry.toPrometheus()).toContain('aegis_orders_total{state="unknown"} 1');
  });

  it('aggregates dependency health and persists degraded state', async () => {
    const persist = vi.fn(async () => undefined);
    const healthy = async () => ({ state: 'UP' as const });
    const monitor = new HealthMonitor(
      {
        application: healthy,
        database: healthy,
        alpaca: async () => ({ state: 'DOWN', message: 'timeout' }),
        'market-data': healthy,
        scheduler: healthy,
        reconciliation: healthy,
        'operational-safety': healthy,
      },
      persist,
    );
    const report = await monitor.check('DEGRADED', 'PAPER');
    expect(report.status).toBe('DOWN');
    expect(persist).toHaveBeenCalledWith(report);
  });
});
