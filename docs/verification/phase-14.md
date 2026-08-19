# Phase 14 verification — portfolio

Status: **PASS**

- Broker account, positions, and orders are normalized with decimal-safe quantities, prices, basis,
  realized/unrealized P&L, cash, equity, and buying power.
- Residual quantities from partial/open orders contribute to per-symbol, gross, net, long, short, and
  concentration exposure.
- Expected-position bindings detect both unexpected broker positions and orphaned internal positions.

Evidence: consolidated exposure and anomaly-detection tests plus position snapshot migration.
