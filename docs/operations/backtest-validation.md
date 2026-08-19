# Backtest research validation

A favorable single run is never evidence for LIVE. Backtests use completed bars, next-bar execution,
official sessions, pre-period warm-up, adjusted corporate-action history, deterministic dataset hashes,
conservative intrabar stop precedence, gap-aware exits, spread/slippage/impact, participation capacity,
session-close exits, commissions and reduced UI curves calculated from full-resolution metrics.

Build a JSON array of study runs with the `BacktestStudyRun` fields and validate it with:

```powershell
pnpm backtest:validate -- .\work\study-runs.json
```

The command exits nonzero unless the campaign contains at least two complete chronological
walk-forward folds, real out-of-sample segments, three parameter sets, three transaction-cost levels,
three regimes, three symbols, multiple periods, positive mean benchmark alpha, acceptable capacity,
at least 100 out-of-sample trades and a positive 5th-percentile deterministic sequence bootstrap. It
prints a SHA-256 artifact identifier. Preserve the source, report, dataset hashes, code SHA and exact
configuration together; changing any of them requires a new study.

Passing this tool does not approve LIVE. An independent reviewer must reproduce the report and attest
its artifact through the controlled validation endpoint. The 30-day attestation expires and the
deployment still requires PAPER soak, operational drills and every other readiness check.
