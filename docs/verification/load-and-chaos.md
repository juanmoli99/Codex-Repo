# Load and fault-injection verification

The read-only load smoke rotates through the consolidated snapshot and paginated orders, logs,
backtests and reconciliation APIs. Run it only against PAPER/staging with an authenticated cookie:

```powershell
$env:AEGIS_BASE_URL='https://paper-control.example'
$env:AEGIS_SESSION_COOKIE='__Host-aegis_session=REDACTED'
pnpm load:smoke
```

Defaults are 500 requests, concurrency 10, 10-second per-request deadline and p95 ≤ 2 seconds. Override
with `AEGIS_LOAD_REQUESTS`, `AEGIS_LOAD_CONCURRENCY` and `AEGIS_LOAD_MAXIMUM_P95_MS`. Never paste the
cookie into a committed file and revoke the session after the run.

Automated fault cases cover broker loss before/after write, lost submit response, UNKNOWN recovery,
market-data invalidation/warm-up, dependency health failure, reconciliation mismatch, distributed
worker exclusion and a kill switch racing the submit boundary. Deployment-specific broker,
market-data, database, watchdog and mid-session restart drills still require fresh hashed evidence;
unit fault injection is not accepted as a substitute by LIVE readiness.
