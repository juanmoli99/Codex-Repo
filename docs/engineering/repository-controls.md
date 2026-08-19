# Repository controls

The hosting administrator must protect `main`; repository files cannot enforce server-side policy.
Require pull requests, one independent approval, resolved conversations, linear history, signed commits,
the `CI / verify` and `CI / secret-scan` checks, and dismissal of stale approvals. Disable force-push and
branch deletion. Restrict tag creation for `v*` to release maintainers.

Configure the `release` environment with an independent reviewer. Configure `live` with a different
independent reviewer and no bypass. The LIVE workflow accepts image digests only and deliberately does
not auto-deploy: promotion to the isolated LIVE host remains a separately audited operation.
