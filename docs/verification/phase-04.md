# Phase 4 verification — Alpaca integration

Status: **PASS (contract-tested; no credentials used)**

- PAPER/LIVE authentication selects strictly separated hosts and credentials.
- Account, clock, calendar/early closes, assets, orders, positions, activities/fills, submit, cancel,
  cancel-all, and replace endpoints are implemented.
- Shared token-bucket budgeting covers trading, scanner, data, and execution traffic.
- Timeouts, typed network/HTTP errors, safe retries with exponential backoff/jitter, and a circuit
  breaker are implemented.
- Non-idempotent operations are never blindly retried; a lost response produces an explicit UNKNOWN
  outcome keyed by client order ID.
- Broker request IDs and latencies are loggable/persistable, and external orders are detectable.

Evidence: HTTP transport fault-injection tests, circuit-breaker tests, strict types, and official Alpaca
response schemas.
