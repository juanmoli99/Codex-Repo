# Phase 20 verification — trade executor and advanced orders

Status: **PASS (broker contract-tested; PAPER credentials not supplied)**

- Versioned trade intents pass fresh validation, sizing, risk, and safety gates immediately before an
  order request is built.
- Market, limit, stop, stop-limit, trailing-stop, bracket, OCO, and OTO representations cover TIF,
  price/quantity precision, extended-hours restrictions, and price sanity.
- Intent and order are persisted before submit under a unique client order ID. The transport never
  retries a non-idempotent submit; a lost response becomes `UNKNOWN` and queues mandatory reconciliation.
- Parent/child protection groups retain leg identity/state, activate children after partial parent fills,
  cancel the losing OCO sibling, reconcile races, recover after restart, and detect incomplete brackets.

Evidence: persisted-before-submit, retry deduplication, UNKNOWN fault injection, state-machine, partial
fill, OCO race, and bracket recovery tests.
