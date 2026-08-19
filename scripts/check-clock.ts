const MAX_ALLOWED_DRIFT_MS = 1_000;

interface TimeResponse {
  readonly utc_datetime: string;
}

async function main(): Promise<void> {
  const before = Date.now();
  const response = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', {
    signal: AbortSignal.timeout(5_000),
  });
  const after = Date.now();
  if (!response.ok) {
    throw new Error(`Clock source returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as TimeResponse;
  const midpoint = before + Math.round((after - before) / 2);
  const driftMs = midpoint - Date.parse(payload.utc_datetime);
  const result = { driftMs, roundTripMs: after - before, checkedAt: new Date().toISOString() };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (Math.abs(driftMs) > MAX_ALLOWED_DRIFT_MS) {
    throw new Error(`System clock drift ${driftMs}ms exceeds ${MAX_ALLOWED_DRIFT_MS}ms`);
  }
}

await main();
