# Phase 6 verification — market data

Status: **PASS**

- Historical/latest bars, quotes, and trades support timeframes, pagination, normalization, adjustment,
  IEX/SIP selection, caching, duplicate request coalescing, and shared rate limiting.
- Bars are checked for time validity/order, duplicates, OHLC consistency, finite positive prices,
  volume, missing/future/stale/out-of-session data, and implausible price jumps.
- Formal health is `HEALTHY / STALE / UNAVAILABLE / INCONSISTENT`; non-healthy data blocks entries.
- Feed recovery requires a configured warm-up before reopening.

Evidence: anomaly-injection and recovery warm-up tests plus persistence migration.
