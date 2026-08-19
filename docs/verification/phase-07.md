# Phase 7 verification — trading halts and LULD

Status: **PASS**

- Alpaca SIP/IEX stream subscriptions process trading statuses and LULD bands with reconnect/backoff.
- Halt reason/time and LULD bands are captured; new orders/signals/prices are invalidated immediately.
- Open orders and affected positions are marked for review rather than modified blindly.
- Resume enters cooldown and requires complete downstream revalidation before trading is restored.

Evidence: deterministic halt/resume/cooldown state-machine tests and immutable halt-event persistence.
