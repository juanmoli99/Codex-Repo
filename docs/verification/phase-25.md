# Phase 25 verification — open-position management

Status: **PASS**

- Positions remain bound to strategy/version and support stop-loss, take-profit, trailing stop,
  break-even, time stop, strategy/risk/emergency/manual exits, and partial/full reduction.
- Exit priority is conservative (emergency, risk, hard protection, time, strategy), with a pending-exit
  identity preventing duplicate exits through fill races.
- Position increases are rejected unless the position was explicitly designed to allow them; partial
  fills recalculate weighted entry and protection state.

Evidence: break-even/trailing protection, duplicate-exit, full-exit, and forbidden-pyramiding tests.
