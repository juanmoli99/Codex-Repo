# Phase 8 verification — corporate actions

Status: **PASS**

- Current Alpaca corporate-actions pagination and all required action categories are represented.
- Split quantity/per-share basis adjustments, symbol replacements, watchlist/strategy/cache invalidation,
  and affected order review are planned atomically.
- Mergers, spin-offs, redemptions, delistings, worthless removals, reorganizations, and partial calls are
  treated as ambiguous and block entries until broker reconciliation.
- Adjustment history is immutable and deduplicated at database level.

Evidence: split and ambiguous-merger tests plus applied PostgreSQL migration.
