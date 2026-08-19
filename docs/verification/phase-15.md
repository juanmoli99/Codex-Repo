# Phase 15 verification — cost basis and tax lots

Status: **PASS**

- Tax lots retain original/remaining quantity, acquisition fill/date/price, and per-share basis.
- FIFO dispositions allocate proceeds, basis, and realized P&L by lot while rejecting unavailable
  quantity.
- Basis adjustments and broker reconciliation are historical; wash-sale detection covers replacement
  purchases in the 30 days before and after a loss sale, calculates disallowed loss, and adjusts the
  replacement lot.

Evidence: FIFO loss, future replacement purchase, partial wash allocation, and over-disposition tests.
