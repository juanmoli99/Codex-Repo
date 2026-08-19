# Phase 17 verification — position sizing

Status: **PASS**

- Monetary/percentage risk, explicit-stop or ATR distance, and all capital, cash, buying-power,
  existing/pending exposure, symbol, notional, and quantity caps participate in sizing.
- Fractional eligibility and symbol price/quantity precision use directional decimal rounding.
- Invalid/zero inputs and below-minimum outputs are rejected with explainable calculations and the
  binding constraint.

Evidence: stop-based sizing, cap selection, precision, and zero-stop adversarial tests.
