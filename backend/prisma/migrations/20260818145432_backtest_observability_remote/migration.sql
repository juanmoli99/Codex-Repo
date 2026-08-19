-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('PENDING', 'SENT', 'FAILED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL', 'EMERGENCY');

-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" UUID NOT NULL,
    "configurationId" VARCHAR(128) NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "strategyVersion" VARCHAR(64) NOT NULL,
    "configurationVersion" VARCHAR(128) NOT NULL,
    "inputConfiguration" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_trades" (
    "id" UUID NOT NULL,
    "backtestRunId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "strategyVersion" VARCHAR(64) NOT NULL,
    "configurationVersion" VARCHAR(128) NOT NULL,
    "entrySignalAt" TIMESTAMPTZ(6) NOT NULL,
    "enteredAt" TIMESTAMPTZ(6) NOT NULL,
    "entryPrice" DECIMAL(20,8) NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "exitedAt" TIMESTAMPTZ(6) NOT NULL,
    "exitPrice" DECIMAL(20,8) NOT NULL,
    "exitReason" VARCHAR(32) NOT NULL,
    "commission" DECIMAL(20,8) NOT NULL,
    "pnl" DECIMAL(20,8) NOT NULL,
    "holdingMs" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_equity_points" (
    "id" UUID NOT NULL,
    "backtestRunId" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "equity" DECIMAL(20,8) NOT NULL,
    "drawdownPercent" DECIMAL(10,6) NOT NULL,

    CONSTRAINT "backtest_equity_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_snapshots" (
    "id" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "systemState" VARCHAR(32) NOT NULL,
    "tradingMode" "TradingMode" NOT NULL,
    "components" JSONB NOT NULL,
    "checkedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_snapshots" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "labels" JSONB NOT NULL,
    "value" DECIMAL(30,10) NOT NULL,
    "capturedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "state" "AlertState" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "component" VARCHAR(128) NOT NULL,
    "correlationId" UUID,
    "metadata" JSONB NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstOccurredAt" TIMESTAMPTZ(6) NOT NULL,
    "lastOccurredAt" TIMESTAMPTZ(6) NOT NULL,
    "nextDeliveryAt" TIMESTAMPTZ(6) NOT NULL,
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMPTZ(6),
    "acknowledgedAt" TIMESTAMPTZ(6),
    "acknowledgedBy" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_deliveries" (
    "id" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "channel" VARCHAR(64) NOT NULL,
    "attempt" INTEGER NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "error" TEXT,
    "attemptedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_operation_audit" (
    "id" UUID NOT NULL,
    "actor" VARCHAR(128) NOT NULL,
    "channel" VARCHAR(64) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "reason" TEXT NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "metadata" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remote_operation_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backtest_runs_strategyId_strategyVersion_finishedAt_idx" ON "backtest_runs"("strategyId", "strategyVersion", "finishedAt");

-- CreateIndex
CREATE INDEX "backtest_runs_symbol_finishedAt_idx" ON "backtest_runs"("symbol", "finishedAt");

-- CreateIndex
CREATE INDEX "backtest_trades_backtestRunId_enteredAt_idx" ON "backtest_trades"("backtestRunId", "enteredAt");

-- CreateIndex
CREATE UNIQUE INDEX "backtest_equity_points_backtestRunId_timestamp_key" ON "backtest_equity_points"("backtestRunId", "timestamp");

-- CreateIndex
CREATE INDEX "health_snapshots_status_checkedAt_idx" ON "health_snapshots"("status", "checkedAt");

-- CreateIndex
CREATE INDEX "metric_snapshots_name_capturedAt_idx" ON "metric_snapshots"("name", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_fingerprint_key" ON "alerts"("fingerprint");

-- CreateIndex
CREATE INDEX "alerts_state_severity_nextDeliveryAt_idx" ON "alerts"("state", "severity", "nextDeliveryAt");

-- CreateIndex
CREATE INDEX "alerts_kind_lastOccurredAt_idx" ON "alerts"("kind", "lastOccurredAt");

-- CreateIndex
CREATE INDEX "alert_deliveries_attemptedAt_outcome_idx" ON "alert_deliveries"("attemptedAt", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "alert_deliveries_alertId_channel_attempt_key" ON "alert_deliveries"("alertId", "channel", "attempt");

-- CreateIndex
CREATE INDEX "remote_operation_audit_actor_occurredAt_idx" ON "remote_operation_audit"("actor", "occurredAt");

-- CreateIndex
CREATE INDEX "remote_operation_audit_action_outcome_occurredAt_idx" ON "remote_operation_audit"("action", "outcome", "occurredAt");

-- AddForeignKey
ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_backtestRunId_fkey" FOREIGN KEY ("backtestRunId") REFERENCES "backtest_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_equity_points" ADD CONSTRAINT "backtest_equity_points_backtestRunId_fkey" FOREIGN KEY ("backtestRunId") REFERENCES "backtest_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
