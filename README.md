# Aegis Trading Platform

A safety-first, single-operator algorithmic trading platform for US equities through Alpaca. It
combines multiple versioned strategies with regime selection, market-data validation, risk-based
position sizing, broker-authoritative reconciliation, execution state machines, observability,
backtesting, remote safety controls, and a React control plane. The system defaults to PAPER and
refuses LIVE operation unless every independent activation guard is satisfied.

## Prerequisites

- Node.js 24+
- pnpm 11+
- PostgreSQL 18+
- An Alpaca PAPER account for broker-connected operation

## Local development

1. Copy `.env.example` to `.env` and provide local secrets.
2. Start PostgreSQL using `infra/compose.yaml` or an equivalent local service.
3. Run `pnpm install --frozen-lockfile`.
4. Run `pnpm db:generate` and `pnpm db:migrate`.
5. Run `pnpm dev`.

The API listens on `http://127.0.0.1:3000`; the web application listens on
`http://127.0.0.1:5173`. Liveness and readiness are available at `/health/live` and
`/health/ready`.

## Safety

- Never place Alpaca secrets in frontend configuration.
- Never commit `.env`, logs, database dumps, private keys, or backup credentials.
- PAPER is the only default and the only mode suitable for development.
- LIVE activation remains unavailable until the formal live-readiness gate passes.

See `docs/engineering/branching.md` for workflow conventions and `infra/time-sync.md` for the clock
policy.

## Verification and operation

Run `pnpm verify` before every deployment. It performs formatting, strict lint, strict TypeScript,
all backend/frontend tests, and production builds. Database migrations are additive and deployment
uses `pnpm db:deploy`. Backup/restore instructions are in `docs/operations/backups.md`; safe strategy
deployment is in `docs/operations/strategy-deployment.md`; the mandatory PAPER-to-LIVE progression is
in `docs/operations/paper-to-live.md`.

`pnpm test:coverage` enforces capital-critical domain gates (80% statements/functions/lines and 75%
branches). CI also scans dependencies, secrets, the filesystem and all four production containers
before release.

Broker connectivity remains disabled unless `BROKER_CONNECTIVITY_ENABLED=true` and mode-specific
credentials are available only to the backend. A normal startup is `ONLY_CLOSE` with entries off.
PAPER operation and a formal readiness assessment must precede LIVE.

The complete Spanish setup and `.env` guide is in
`docs/operations/configuration-and-use.es.md`.
Research-campaign validation is documented in `docs/operations/backtest-validation.md`.

## Risk notice

This software cannot guarantee profits, an efficient return, or protection from loss. Backtests and
PAPER results do not predict future performance. LIVE uses real money and remains deliberately blocked
until real credentials and all deployment-specific checks pass.
