# Phase 27 verification — P&L, runtime risk, and journal

Status: **PASS**

- Decimal-safe analytics calculate realized/unrealized and daily/weekly/monthly P&L by trade, symbol,
  and strategy, along with equity curve, high-water mark, current drawdown, and maximum drawdown.
- Real-time daily-loss, portfolio-risk, and drawdown enforcement selects only-close or kill-switch.
- The append-only journal captures every required stage and manual/safety/reconciliation event with
  correlation ID and monotonic sequence, reconstructing the complete trade timeline.

Evidence: multi-trade equity/drawdown/runtime-kill tests and out-of-order repository timeline test.
