# Phase 36 verification — final LIVE preparation

Status: **PASS (implementation); LIVE intentionally NOT READY**

Requirements 895–916 are represented by mandatory, persisted checks covering mode guards,
reconciliation, recovery, UNKNOWN outcomes, idempotency, risk/sizing/safety, kill/only-close, circuit
breakers, price/liquidity/slippage, scheduler controls, fills/races, external activity, startup
reconciliation, alert delivery, and tested disaster recovery.

Requirements 917–925 are enforced by:

- persisted `NOT_READY / READY_FOR_ACTIVATION / ACTIVE / REVOKED` assessments and individual evidence;
- one-hour assessment expiry and rejection of superseded assessments;
- two-stage CSRF-authenticated activation, an actor-bound five-minute nonce, exact real-money phrase,
  single-use consumption, and serializable database transaction;
- absolute USD 100 order, USD 500 capital, USD 25 daily-loss, 3% drawdown, and USD 1,000 minimum-equity
  caps in the versioned risk configuration and order pipeline;
- a persisted 10-business-day manual-monitoring window and queued critical LIVE alert.

The real startup smoke test produced `PAPER / READY / NOT_READY / ONLY_CLOSE`, with trading and entries
false. This is the required delivery state because no real LIVE credentials, independently verified
LIVE broker account, external alert receipt, successful startup reconciliation, or verified offsite
backup record were supplied. Unit tests prove the complete activation path and all rejection paths
without enabling real-money trading.
