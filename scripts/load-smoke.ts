const baseUrl = process.env.AEGIS_BASE_URL;
const cookie = process.env.AEGIS_SESSION_COOKIE;
if (!baseUrl || !cookie)
  throw new Error(
    'AEGIS_BASE_URL and AEGIS_SESSION_COOKIE are required for the read-only load smoke',
  );
const requests = Math.min(10_000, Math.max(10, Number(process.env.AEGIS_LOAD_REQUESTS ?? 500)));
const concurrency = Math.min(50, Math.max(1, Number(process.env.AEGIS_LOAD_CONCURRENCY ?? 10)));
const maximumP95Ms = Math.max(50, Number(process.env.AEGIS_LOAD_MAXIMUM_P95_MS ?? 2_000));
if (![requests, concurrency, maximumP95Ms].every(Number.isFinite))
  throw new Error('Load parameters must be finite numbers');

const paths = [
  '/api/operations/snapshot',
  '/api/orders?limit=50',
  '/api/logs?limit=50',
  '/api/backtests?limit=50',
  '/api/reconciliations?limit=50',
] as const;
const latencies: number[] = [];
const failures: string[] = [];
let next = 0;

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    let index = next;
    next += 1;
    while (index < requests) {
      const path = paths.at(index % paths.length);
      if (path === undefined) throw new Error('Load-test path lookup failed');
      const started = performance.now();
      try {
        const response = await fetch(new URL(path, baseUrl), {
          headers: { cookie, accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        latencies.push(performance.now() - started);
        if (!response.ok) failures.push(`${path}:${response.status}`);
        await response.arrayBuffer();
      } catch (error) {
        failures.push(`${path}:${error instanceof Error ? error.message : 'unknown'}`);
      }
      index = next;
      next += 1;
    }
  }),
);

latencies.sort((left, right) => left - right);
const percentile = (fraction: number): number =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] ?? Infinity;
const report = {
  requests,
  concurrency,
  succeeded: requests - failures.length,
  failed: failures.length,
  latencyMs: {
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    p99: Number(percentile(0.99).toFixed(2)),
  },
  maximumP95Ms,
  passed: failures.length === 0 && percentile(0.95) <= maximumP95Ms,
  sampleFailures: failures.slice(0, 10),
};
process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
if (!report.passed) process.exitCode = 2;
