-- CreateEnum
CREATE TYPE "StrategyLifecycle" AS ENUM ('ACTIVE', 'RETIRING', 'DISABLED');

-- CreateEnum
CREATE TYPE "StrategySignalType" AS ENUM ('BUY', 'SELL', 'HOLD', 'EXIT');

-- CreateEnum
CREATE TYPE "StrategySignalState" AS ENUM ('ACTIVE', 'EXPIRED', 'INVALIDATED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "ScannerExecutionStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "RiskDecisionOutcome" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SafetyMode" AS ENUM ('NORMAL', 'ONLY_CLOSE', 'KILL_SWITCH', 'EMERGENCY_STOP');

-- CreateTable
CREATE TABLE "position_snapshots" (
    "id" UUID NOT NULL,
    "portfolioSnapshotId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "side" VARCHAR(16) NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "averageEntryPrice" DECIMAL(20,8) NOT NULL,
    "marketPrice" DECIMAL(20,8) NOT NULL,
    "marketValue" DECIMAL(20,8) NOT NULL,
    "costBasis" DECIMAL(20,8) NOT NULL,
    "unrealizedPnl" DECIMAL(20,8) NOT NULL,
    "realizedPnl" DECIMAL(20,8) NOT NULL,
    "pendingOrderExposure" DECIMAL(20,8) NOT NULL,
    "strategyId" VARCHAR(128),
    "strategyVersion" VARCHAR(64),
    "unexpected" BOOLEAN NOT NULL DEFAULT false,
    "orphaned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_versions" (
    "id" UUID NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "configurationVersion" VARCHAR(128) NOT NULL,
    "deploymentId" VARCHAR(128) NOT NULL,
    "lifecycle" "StrategyLifecycle" NOT NULL,
    "parameters" JSONB NOT NULL,
    "requiredIndicators" JSONB NOT NULL,
    "assetOverrides" JSONB,
    "cooldownMs" INTEGER NOT NULL,
    "maximumSignalsPerDay" INTEGER NOT NULL,
    "maximumTradesPerDay" INTEGER NOT NULL,
    "activatedAt" TIMESTAMPTZ(6),
    "retiredAt" TIMESTAMPTZ(6),
    "disabledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_signals" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "strategyVersion" VARCHAR(64) NOT NULL,
    "configurationVersion" VARCHAR(128) NOT NULL,
    "deploymentId" VARCHAR(128) NOT NULL,
    "type" "StrategySignalType" NOT NULL,
    "state" "StrategySignalState" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "confidence" DECIMAL(8,6),
    "expectedEdgeBps" DECIMAL(12,4),
    "parametersSnapshot" JSONB NOT NULL,
    "configurationSnapshot" JSONB NOT NULL,
    "deduplicationKey" CHAR(64) NOT NULL,
    "signaledAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "invalidatedAt" TIMESTAMPTZ(6),
    "invalidationReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_position_bindings" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "strategyVersion" VARCHAR(64) NOT NULL,
    "openedBySignalId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "boundAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMPTZ(6),

    CONSTRAINT "strategy_position_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_version_migrations" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "fromVersion" VARCHAR(64) NOT NULL,
    "toVersion" VARCHAR(64) NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedBy" VARCHAR(128) NOT NULL,
    "migratedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_version_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_executions" (
    "id" UUID NOT NULL,
    "idempotencyKey" VARCHAR(256) NOT NULL,
    "trigger" VARCHAR(32) NOT NULL,
    "status" "ScannerExecutionStatus" NOT NULL,
    "symbolsProcessed" INTEGER NOT NULL DEFAULT 0,
    "symbolsFailed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scanner_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_results" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128),
    "signalId" UUID,
    "accepted" BOOLEAN NOT NULL,
    "rank" INTEGER,
    "score" DECIMAL(16,8),
    "rejectionCode" VARCHAR(128),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scanner_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_lots" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "acquisitionFillId" VARCHAR(128) NOT NULL,
    "acquiredAt" TIMESTAMPTZ(6) NOT NULL,
    "acquisitionPrice" DECIMAL(20,8) NOT NULL,
    "originalQuantity" DECIMAL(30,12) NOT NULL,
    "remainingQuantity" DECIMAL(30,12) NOT NULL,
    "basisPerShare" DECIMAL(20,8) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_dispositions" (
    "id" UUID NOT NULL,
    "saleFillId" VARCHAR(128) NOT NULL,
    "lotId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "soldAt" TIMESTAMPTZ(6) NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "proceeds" DECIMAL(20,8) NOT NULL,
    "costBasis" DECIMAL(20,8) NOT NULL,
    "realizedPnl" DECIMAL(20,8) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_basis_adjustments" (
    "id" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "detail" TEXT NOT NULL,
    "adjustedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_basis_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wash_sales" (
    "id" UUID NOT NULL,
    "saleFillId" VARCHAR(128) NOT NULL,
    "replacementLotId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "replacementQuantity" DECIMAL(30,12) NOT NULL,
    "disallowedLoss" DECIMAL(20,8) NOT NULL,
    "detectedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wash_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_configurations" (
    "id" VARCHAR(256) NOT NULL,
    "version" VARCHAR(128) NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "configuration" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(6),

    CONSTRAINT "risk_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_decisions" (
    "id" UUID NOT NULL,
    "signalId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "outcome" "RiskDecisionOutcome" NOT NULL,
    "reasonCodes" JSONB NOT NULL,
    "riskConfigurationId" VARCHAR(256) NOT NULL,
    "decisionSnapshot" JSONB NOT NULL,
    "evaluatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "version" INTEGER NOT NULL DEFAULT 0,
    "tradingMode" "TradingMode" NOT NULL,
    "mode" "SafetyMode" NOT NULL,
    "tradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "entriesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "exitsAllowed" BOOLEAN NOT NULL DEFAULT true,
    "globalLockOwner" VARCHAR(256),
    "blocks" JSONB NOT NULL,
    "lastChangedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "safety_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_audit" (
    "id" UUID NOT NULL,
    "action" VARCHAR(128) NOT NULL,
    "actor" VARCHAR(128) NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "position_snapshots_portfolioSnapshotId_symbol_idx" ON "position_snapshots"("portfolioSnapshotId", "symbol");

-- CreateIndex
CREATE INDEX "strategy_versions_strategyId_lifecycle_idx" ON "strategy_versions"("strategyId", "lifecycle");

-- CreateIndex
CREATE INDEX "strategy_versions_deploymentId_idx" ON "strategy_versions"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_versions_strategyId_version_key" ON "strategy_versions"("strategyId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_signals_deduplicationKey_key" ON "strategy_signals"("deduplicationKey");

-- CreateIndex
CREATE INDEX "strategy_signals_symbol_signaledAt_idx" ON "strategy_signals"("symbol", "signaledAt");

-- CreateIndex
CREATE INDEX "strategy_signals_strategyId_strategyVersion_signaledAt_idx" ON "strategy_signals"("strategyId", "strategyVersion", "signaledAt");

-- CreateIndex
CREATE INDEX "strategy_signals_state_expiresAt_idx" ON "strategy_signals"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "strategy_position_bindings_symbol_active_idx" ON "strategy_position_bindings"("symbol", "active");

-- CreateIndex
CREATE INDEX "strategy_position_bindings_strategyId_strategyVersion_activ_idx" ON "strategy_position_bindings"("strategyId", "strategyVersion", "active");

-- CreateIndex
CREATE INDEX "strategy_version_migrations_strategyId_symbol_migratedAt_idx" ON "strategy_version_migrations"("strategyId", "symbol", "migratedAt");

-- CreateIndex
CREATE UNIQUE INDEX "scanner_executions_idempotencyKey_key" ON "scanner_executions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "scanner_executions_startedAt_idx" ON "scanner_executions"("startedAt");

-- CreateIndex
CREATE INDEX "scanner_executions_status_idx" ON "scanner_executions"("status");

-- CreateIndex
CREATE INDEX "scanner_results_executionId_accepted_rank_idx" ON "scanner_results"("executionId", "accepted", "rank");

-- CreateIndex
CREATE INDEX "scanner_results_symbol_createdAt_idx" ON "scanner_results"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "tax_lots_symbol_acquiredAt_idx" ON "tax_lots"("symbol", "acquiredAt");

-- CreateIndex
CREATE INDEX "tax_lots_acquisitionFillId_idx" ON "tax_lots"("acquisitionFillId");

-- CreateIndex
CREATE INDEX "lot_dispositions_saleFillId_idx" ON "lot_dispositions"("saleFillId");

-- CreateIndex
CREATE INDEX "lot_dispositions_lotId_soldAt_idx" ON "lot_dispositions"("lotId", "soldAt");

-- CreateIndex
CREATE INDEX "cost_basis_adjustments_lotId_adjustedAt_idx" ON "cost_basis_adjustments"("lotId", "adjustedAt");

-- CreateIndex
CREATE INDEX "wash_sales_symbol_detectedAt_idx" ON "wash_sales"("symbol", "detectedAt");

-- CreateIndex
CREATE INDEX "wash_sales_saleFillId_replacementLotId_idx" ON "wash_sales"("saleFillId", "replacementLotId");

-- CreateIndex
CREATE UNIQUE INDEX "risk_configurations_version_key" ON "risk_configurations"("version");

-- CreateIndex
CREATE UNIQUE INDEX "risk_configurations_checksum_key" ON "risk_configurations"("checksum");

-- CreateIndex
CREATE INDEX "risk_configurations_active_idx" ON "risk_configurations"("active");

-- CreateIndex
CREATE INDEX "risk_decisions_signalId_idx" ON "risk_decisions"("signalId");

-- CreateIndex
CREATE INDEX "risk_decisions_symbol_evaluatedAt_idx" ON "risk_decisions"("symbol", "evaluatedAt");

-- CreateIndex
CREATE INDEX "risk_decisions_outcome_evaluatedAt_idx" ON "risk_decisions"("outcome", "evaluatedAt");

-- CreateIndex
CREATE INDEX "safety_audit_occurredAt_idx" ON "safety_audit"("occurredAt");

-- CreateIndex
CREATE INDEX "safety_audit_action_occurredAt_idx" ON "safety_audit"("action", "occurredAt");

-- AddForeignKey
ALTER TABLE "position_snapshots" ADD CONSTRAINT "position_snapshots_portfolioSnapshotId_fkey" FOREIGN KEY ("portfolioSnapshotId") REFERENCES "portfolio_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_results" ADD CONSTRAINT "scanner_results_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "scanner_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
