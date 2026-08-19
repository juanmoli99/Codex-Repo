-- Runtime production foundation. All additions are backward-compatible and fail closed.
ALTER TABLE "portfolio_snapshots"
  ADD COLUMN "accountStatus" VARCHAR(64) NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "daytradeCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "market_data_states"
  ADD COLUMN "lastBarAt" TIMESTAMPTZ(6),
  ADD COLUMN "lastQuoteAt" TIMESTAMPTZ(6),
  ADD COLUMN "lastTradeAt" TIMESTAMPTZ(6),
  ADD COLUMN "warmupCompletedAt" TIMESTAMPTZ(6),
  ADD COLUMN "recoveryEvidence" JSONB;

ALTER TABLE "strategy_versions"
  ADD COLUMN "timeframe" VARCHAR(16) NOT NULL DEFAULT '1Min',
  ADD COLUMN "sessionPolicy" VARCHAR(32) NOT NULL DEFAULT 'REGULAR_ONLY',
  ADD COLUMN "overnightPolicy" VARCHAR(32) NOT NULL DEFAULT 'FLAT_AT_CLOSE',
  ADD COLUMN "eventRiskPolicy" VARCHAR(32) NOT NULL DEFAULT 'BLOCK_ENTRIES',
  ADD COLUMN "commitSha" VARCHAR(64),
  ADD COLUMN "buildChecksum" CHAR(64);

ALTER TABLE "risk_configurations"
  ADD COLUMN "activatedBy" VARCHAR(128),
  ADD COLUMN "supersedesId" VARCHAR(256);

ALTER TABLE "reconciliations"
  ADD COLUMN "brokerSnapshot" JSONB,
  ADD COLUMN "localSnapshot" JSONB;

ALTER TABLE "scheduler_state"
  ADD COLUMN "workerId" VARCHAR(128),
  ADD COLUMN "workerHeartbeatAt" TIMESTAMPTZ(6),
  ADD COLUMN "lastDriftMs" INTEGER;

ALTER TABLE "scheduler_executions"
  ADD COLUMN "candidateCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rejectionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "errorCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "circuit_breakers" (
  "key" VARCHAR(256) NOT NULL,
  "scope" VARCHAR(32) NOT NULL,
  "scopeId" VARCHAR(128),
  "state" VARCHAR(32) NOT NULL,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "threshold" INTEGER NOT NULL,
  "reason" TEXT,
  "openedAt" TIMESTAMPTZ(6),
  "cooldownUntil" TIMESTAMPTZ(6),
  "lastFailureAt" TIMESTAMPTZ(6),
  "lastSuccessAt" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "circuit_breakers_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "circuit_breakers_scope_state_idx" ON "circuit_breakers"("scope", "state");
CREATE INDEX "circuit_breakers_cooldownUntil_idx" ON "circuit_breakers"("cooldownUntil");

CREATE TABLE "worker_heartbeats" (
  "id" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "leader" BOOLEAN NOT NULL DEFAULT false,
  "startedAt" TIMESTAMPTZ(6) NOT NULL,
  "heartbeatAt" TIMESTAMPTZ(6) NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "worker_heartbeats_kind_heartbeatAt_idx" ON "worker_heartbeats"("kind", "heartbeatAt");

CREATE TABLE "rate_limit_budgets" (
  "id" VARCHAR(128) NOT NULL,
  "tokens" DECIMAL(20,8) NOT NULL,
  "capacity" DECIMAL(20,8) NOT NULL,
  "refillPerSecond" DECIMAL(20,8) NOT NULL,
  "lastRefillAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "rate_limit_budgets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "market_clock" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "isOpen" BOOLEAN NOT NULL,
  "session" VARCHAR(32) NOT NULL,
  "brokerTime" TIMESTAMPTZ(6) NOT NULL,
  "nextOpen" TIMESTAMPTZ(6) NOT NULL,
  "nextClose" TIMESTAMPTZ(6) NOT NULL,
  "observedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "market_clock_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "market_clock_observedAt_idx" ON "market_clock"("observedAt");

CREATE TABLE "backtest_jobs" (
  "id" UUID NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "request" JSONB NOT NULL,
  "datasetHash" CHAR(64),
  "runId" UUID,
  "error" TEXT,
  "cancelAt" TIMESTAMPTZ(6),
  "startedAt" TIMESTAMPTZ(6),
  "finishedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "backtest_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "backtest_jobs_status_createdAt_idx" ON "backtest_jobs"("status", "createdAt");

-- Financial ownership is unique even under concurrent processes.
CREATE UNIQUE INDEX "strategy_position_bindings_one_active_per_symbol"
  ON "strategy_position_bindings"("symbol") WHERE "active" = true;
CREATE UNIQUE INDEX "managed_positions_one_open_per_symbol"
  ON "managed_positions"("symbol") WHERE "closedAt" IS NULL;
