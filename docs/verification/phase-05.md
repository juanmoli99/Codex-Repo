# Phase 5 verification — account and regulatory restrictions

Status: **PASS**

- The account guard classifies cash/margin behavior, broker blocks, buying power, day-trading buying
  power, settled cash, shorting, marginability, and asset restrictions.
- Rules are versioned and persistable with effective dates and immutable checksums.
- The 2026 FINRA transition is modeled as broker-authoritative: local logic never overrides a stricter
  broker limit and blocks any local/broker buying-power mismatch.

Evidence: restrictive PDT/buying-power tests and the `regulatory_rule_versions` migration.
