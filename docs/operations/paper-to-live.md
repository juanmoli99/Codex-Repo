# PAPER-to-LIVE runbook

LIVE uses real money. No strategy, backtest, or test suite guarantees profit or prevents loss. The
application is delivered in PAPER, `ONLY_CLOSE`, with entries disabled. Never weaken a failed check to
force activation.

## Immutable initial limits

- maximum order notional: USD 100;
- maximum allocated capital: USD 500;
- maximum daily loss: USD 25;
- maximum drawdown: 3%;
- minimum broker-authoritative equity: USD 1,000;
- maximum three positions, three open orders, and five daily trades;
- intensive manual monitoring for the first 10 business days.

The same limits are enforced in position sizing, the pre-trade gate, the final executor gate, and the
persisted activation record. A change requires a new versioned risk snapshot and a new assessment.

## Required progression

1. Operate PAPER through representative market conditions and resolve every safety/reconciliation
   discrepancy. Confirm order, partial-fill, cancel/fill, disconnect, UNKNOWN, and restart scenarios.
2. Configure and verify Telegram plus fallback email delivery. Produce a successful persisted delivery.
3. Upload a backup off host, restore it into an isolated target, and persist the verified backup record.
4. Configure `APP_ENV=production`, `TRADING_MODE=LIVE`, `BROKER_CONNECTIVITY_ENABLED=true`,
   `ENABLE_LIVE_TRADING=true`, the exact startup phrase, and separate LIVE credentials through a secret
   manager. A LIVE deployment requires the consolidated `sip` market-data feed and its account
   entitlement; IEX remains suitable only for PAPER qualification. Restart remains `BLOCKED` /
   `ONLY_CLOSE`.
   When PAPER and LIVE are isolated, import only qualification evidence—not PAPER orders or positions—
   through `POST /api/operations/actions/validation-attest`. The request requires password, TOTP,
   `CONFIRMAR`, an allowlisted validation kind, a 64-character artifact SHA-256, execution timestamp,
   source environment and detailed evidence. Attestations older than 30 days are rejected and never
   replace broker-authoritative LIVE reconciliation.
5. Reconcile against the LIVE account. The broker account endpoint—not a hostname assumption—must
   independently identify the account as LIVE. Run `POST /api/live-readiness/assess` using an
   authenticated CSRF-protected operator session.
6. Inspect every persisted check returned by `GET /api/live-readiness`. Activation is unavailable
   unless the current, unexpired assessment is `READY_FOR_ACTIVATION`.
7. Request a five-minute, actor-bound, single-use challenge with
   `POST /api/live-readiness/challenge`, the assessment ID, and exact confirmation `PREPARAR LIVE`.
8. Submit the returned nonce once to `POST /api/live-readiness/activate` with exact phrase
   `I_UNDERSTAND_REAL_MONEY_IS_AT_RISK` and `manualMonitoringAcknowledged: true`.

Activation runs as one serializable PostgreSQL transaction. It consumes the challenge, activates only
the newest assessment, verifies an unblocked `ONLY_CLOSE` safety state, applies the initial limits,
enables trading, changes system state to `READY`, and queues an `EMERGENCY`-severity LIVE-activation
alert. Any failure rolls back the complete operation.

## First 10 business days

An operator must watch every open, rejection, fill, protection leg, P&L limit, broker connection,
reconciliation, and alert. Keep the kill switch immediately available. Do not raise caps during this
period. Any UNKNOWN order, external activity, data-quality failure, missed critical alert, daily loss,
or reconciliation mismatch returns the system to a fail-closed state and requires a fresh assessment.
