export type MetricLabels = Readonly<Record<string, string>>;

interface MetricPoint {
  value: number;
  samples: number[];
}

function labelKey(labels: MetricLabels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
}

function assertMetricName(name: string): void {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Invalid metric name: ${name}`);
}

export class MetricRegistry {
  private readonly points = new Map<string, Map<string, MetricPoint>>();
  private readonly labelSets = new Map<string, Map<string, MetricLabels>>();

  public increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error('Counter increment must be non-negative');
    const point = this.point(name, labels);
    point.value += amount;
  }

  public gauge(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) throw new Error('Gauge must be finite');
    this.point(name, labels).value = value;
  }

  public observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) throw new Error('Observation must be non-negative');
    const point = this.point(name, labels);
    point.samples.push(value);
    if (point.samples.length > 10_000) point.samples.shift();
  }

  public value(name: string, labels: MetricLabels = {}): number | undefined {
    return this.points.get(name)?.get(labelKey(labels))?.value;
  }

  public summary(
    name: string,
    labels: MetricLabels = {},
  ): { count: number; average: number; p95: number } | undefined {
    const samples = this.points.get(name)?.get(labelKey(labels))?.samples;
    if (samples === undefined || samples.length === 0) return undefined;
    const ordered = [...samples].sort((left, right) => left - right);
    const p95Index = Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1);
    return {
      count: ordered.length,
      average: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
      p95: ordered[p95Index] ?? 0,
    };
  }

  public toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, points] of [...this.points].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      for (const [key, point] of points) {
        const labels = this.labelSets.get(name)?.get(key) ?? {};
        const renderedLabels = Object.entries(labels)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(
            ([label, value]) =>
              `${label}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
          )
          .join(',');
        const suffix = renderedLabels.length === 0 ? '' : `{${renderedLabels}}`;
        lines.push(`${name}${suffix} ${point.value}`);
        if (point.samples.length > 0) {
          const summary = this.summary(name, labels);
          if (summary !== undefined) {
            lines.push(`${name}_count${suffix} ${summary.count}`);
            lines.push(`${name}_average${suffix} ${summary.average}`);
            lines.push(`${name}_p95${suffix} ${summary.p95}`);
          }
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private point(name: string, labels: MetricLabels): MetricPoint {
    assertMetricName(name);
    const key = labelKey(labels);
    const metric = this.points.get(name) ?? new Map<string, MetricPoint>();
    const labelMap = this.labelSets.get(name) ?? new Map<string, MetricLabels>();
    const point = metric.get(key) ?? { value: 0, samples: [] };
    metric.set(key, point);
    labelMap.set(key, { ...labels });
    this.points.set(name, metric);
    this.labelSets.set(name, labelMap);
    return point;
  }
}

export class TradingMetrics {
  public constructor(private readonly registry: MetricRegistry) {}

  public alpacaLatency(milliseconds: number): void {
    this.registry.observe('aegis_alpaca_latency_ms', milliseconds);
  }
  public marketDataLatency(milliseconds: number): void {
    this.registry.observe('aegis_market_data_latency_ms', milliseconds);
  }
  public order(state: 'created' | 'filled' | 'rejected' | 'unknown' | 'partial'): void {
    this.registry.increment('aegis_orders_total', { state });
  }
  public error(): void {
    this.registry.increment('aegis_errors_total');
  }
  public scannerDuration(milliseconds: number): void {
    this.registry.observe('aegis_scanner_duration_ms', milliseconds);
  }
  public schedulerDuration(milliseconds: number): void {
    this.registry.observe('aegis_scheduler_duration_ms', milliseconds);
  }
  public reconciliationDiscrepancies(count: number): void {
    this.registry.gauge('aegis_reconciliation_discrepancies', count);
  }
  public strategyPerformance(strategyId: string, netPnl: number): void {
    this.registry.gauge('aegis_strategy_net_pnl', netPnl, { strategy: strategyId });
  }
  public lastSuccess(component: 'scanner' | 'scheduler' | 'reconciliation', timestamp: Date): void {
    this.registry.gauge('aegis_last_success_timestamp_seconds', timestamp.getTime() / 1_000, {
      component,
    });
  }
}
