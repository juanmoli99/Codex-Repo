# Phase 23 verification — reconciliation

Status: **PASS**

- Startup, periodic, manual, timeout, critical-error, and post-restore triggers share one reconciliation
  framework with a unique run ID.
- Orders, statuses, quantities, fills, positions, cash, equity, and buying power are compared against the
  broker with explicit decimal tolerances.
- Missing/external orders, missing fills/positions, unexpected positions, and quantity/state/account
  mismatches are classified. Only monotonic terminal order updates are auto-corrected; ambiguity blocks
  operational safety.

Evidence: safe terminal correction plus simultaneous external-order blocking test and persisted findings.
