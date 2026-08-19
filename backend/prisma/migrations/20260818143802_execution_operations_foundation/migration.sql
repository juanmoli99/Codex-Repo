-- CreateEnum
CREATE TYPE "TradeIntentState" AS ENUM ('CREATED', 'VALIDATING', 'APPROVED', 'EXECUTING', 'SUBMITTED', 'REJECTED', 'UNKNOWN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OrderLifecycleState" AS ENUM ('CREATED', 'VALIDATING', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SchedulerRunState" AS ENUM ('STOPPED', 'RUNNING', 'PAUSED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ReconciliationRunState" AS ENUM ('RUNNING', 'MATCHED', 'CORRECTED', 'BLOCKED', 'FAILED');

-- CreateTable
CREATE TABLE "trade_intents" (
    "id" UUID NOT NULL,
    "deduplicationKey" CHAR(64) NOT NULL,
    "signalId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "strategyVersion" VARCHAR(64) NOT NULL,
    "state" "TradeIntentState" NOT NULL,
    "correlationId" UUID NOT NULL,
    "parentIntentId" UUID,
    "specification" JSONB NOT NULL,
    "immutableConfigurationSnapshot" JSONB NOT NULL,
    "rejectionReasons" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trade_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tradeIntentId" UUID NOT NULL,
    "clientOrderId" VARCHAR(64) NOT NULL,
    "brokerOrderId" VARCHAR(128),
    "symbol" VARCHAR(32) NOT NULL,
    "side" VARCHAR(8) NOT NULL,
    "orderType" VARCHAR(32) NOT NULL,
    "orderClass" VARCHAR(32) NOT NULL,
    "timeInForce" VARCHAR(16) NOT NULL,
    "state" "OrderLifecycleState" NOT NULL,
    "requestedQuantity" DECIMAL(30,12) NOT NULL,
    "filledQuantity" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "averageFillPrice" DECIMAL(20,8),
    "requestedNotional" DECIMAL(20,8),
    "limitPrice" DECIMAL(20,8),
    "stopPrice" DECIMAL(20,8),
    "parentOrderId" UUID,
    "originalOrderId" UUID,
    "fencingToken" BIGINT,
    "brokerResponse" JSONB,
    "reconciliationDue" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_transitions" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fromState" "OrderLifecycleState" NOT NULL,
    "toState" "OrderLifecycleState" NOT NULL,
    "reason" TEXT NOT NULL,
    "brokerStatus" VARCHAR(64),
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fills" (
    "id" VARCHAR(128) NOT NULL,
    "orderId" UUID NOT NULL,
    "tradeIntentId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "side" VARCHAR(8) NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "unexpected" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_groups" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "positionBindingId" UUID NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "protection_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_legs" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "brokerOrderId" VARCHAR(128),
    "role" VARCHAR(32) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "filledQuantity" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "protection_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" VARCHAR(256) NOT NULL,
    "operationType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(128),
    "state" VARCHAR(32) NOT NULL,
    "result" JSONB,
    "ownerId" VARCHAR(128),
    "fencingToken" BIGINT,
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" UUID NOT NULL,
    "trigger" VARCHAR(32) NOT NULL,
    "state" "ReconciliationRunState" NOT NULL,
    "safeCorrectionsApplied" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_discrepancies" (
    "id" UUID NOT NULL,
    "reconciliationId" UUID NOT NULL,
    "code" VARCHAR(128) NOT NULL,
    "classification" VARCHAR(32) NOT NULL,
    "entityId" VARCHAR(128) NOT NULL,
    "localValue" TEXT,
    "brokerValue" TEXT,
    "detail" TEXT NOT NULL,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolution" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recoveries" (
    "id" UUID NOT NULL,
    "trigger" VARCHAR(32) NOT NULL,
    "mode" VARCHAR(32) NOT NULL,
    "actions" JSONB NOT NULL,
    "automaticResumeAllowed" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_positions" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "strategyVersion" VARCHAR(64) NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "remainingQuantity" DECIMAL(30,12) NOT NULL,
    "averageEntryPrice" DECIMAL(20,8) NOT NULL,
    "stopLossPrice" DECIMAL(20,8),
    "takeProfitPrice" DECIMAL(20,8),
    "trailingDistance" DECIMAL(20,8),
    "breakEvenTriggerPrice" DECIMAL(20,8),
    "timeStopAt" TIMESTAMPTZ(6),
    "highWaterPrice" DECIMAL(20,8) NOT NULL,
    "pendingExitIntentId" UUID,
    "allowIncrease" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMPTZ(6) NOT NULL,
    "closedAt" TIMESTAMPTZ(6),
    "exitReason" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "managed_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduler_configurations" (
    "id" VARCHAR(128) NOT NULL,
    "intervalMs" INTEGER NOT NULL,
    "maximumDriftMs" INTEGER NOT NULL,
    "lockTtlMs" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scheduler_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduler_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "state" "SchedulerRunState" NOT NULL,
    "configurationId" VARCHAR(128) NOT NULL,
    "nextExecutionAt" TIMESTAMPTZ(6),
    "lastExecutionAt" TIMESTAMPTZ(6),
    "activeExecutionId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scheduler_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduler_executions" (
    "id" UUID NOT NULL,
    "idempotencyKey" VARCHAR(256) NOT NULL,
    "trigger" VARCHAR(32) NOT NULL,
    "scheduledFor" TIMESTAMPTZ(6) NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "result" VARCHAR(32) NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduler_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_journal" (
    "id" UUID NOT NULL,
    "correlationId" UUID NOT NULL,
    "tradeId" UUID,
    "type" VARCHAR(64) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equity_curve_points" (
    "id" UUID NOT NULL,
    "equity" DECIMAL(20,8) NOT NULL,
    "highWaterMark" DECIMAL(20,8) NOT NULL,
    "drawdown" DECIMAL(20,8) NOT NULL,
    "drawdownPercent" DECIMAL(10,6) NOT NULL,
    "unrealizedPnl" DECIMAL(20,8) NOT NULL,
    "realizedPnl" DECIMAL(20,8) NOT NULL,
    "capturedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equity_curve_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_quality" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "orderType" VARCHAR(32) NOT NULL,
    "decisionPrice" DECIMAL(20,8) NOT NULL,
    "signalPrice" DECIMAL(20,8) NOT NULL,
    "submissionPrice" DECIMAL(20,8) NOT NULL,
    "arrivalPrice" DECIMAL(20,8) NOT NULL,
    "expectedFillPrice" DECIMAL(20,8) NOT NULL,
    "fillPrice" DECIMAL(20,8),
    "absoluteSlippage" DECIMAL(20,8),
    "slippageBps" DECIMAL(12,4),
    "slippageMoney" DECIMAL(20,8),
    "spreadBps" DECIMAL(12,4) NOT NULL,
    "volatility" DECIMAL(12,8) NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "requestedQuantity" DECIMAL(30,12) NOT NULL,
    "fillRatio" DECIMAL(8,6) NOT NULL,
    "partialFill" BOOLEAN NOT NULL DEFAULT false,
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "canceled" BOOLEAN NOT NULL DEFAULT false,
    "signalToSubmitMs" INTEGER NOT NULL,
    "submitToAcceptedMs" INTEGER,
    "acceptedToFillMs" INTEGER,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_quality_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_intents_deduplicationKey_key" ON "trade_intents"("deduplicationKey");

-- CreateIndex
CREATE INDEX "trade_intents_state_updatedAt_idx" ON "trade_intents"("state", "updatedAt");

-- CreateIndex
CREATE INDEX "trade_intents_correlationId_idx" ON "trade_intents"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "trade_intents_signalId_deduplicationKey_key" ON "trade_intents"("signalId", "deduplicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "orders_clientOrderId_key" ON "orders"("clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_brokerOrderId_key" ON "orders"("brokerOrderId");

-- CreateIndex
CREATE INDEX "orders_tradeIntentId_idx" ON "orders"("tradeIntentId");

-- CreateIndex
CREATE INDEX "orders_symbol_state_idx" ON "orders"("symbol", "state");

-- CreateIndex
CREATE INDEX "orders_parentOrderId_idx" ON "orders"("parentOrderId");

-- CreateIndex
CREATE INDEX "orders_originalOrderId_idx" ON "orders"("originalOrderId");

-- CreateIndex
CREATE INDEX "order_transitions_occurredAt_idx" ON "order_transitions"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "order_transitions_orderId_sequence_key" ON "order_transitions"("orderId", "sequence");

-- CreateIndex
CREATE INDEX "fills_tradeIntentId_occurredAt_idx" ON "fills"("tradeIntentId", "occurredAt");

-- CreateIndex
CREATE INDEX "fills_symbol_occurredAt_idx" ON "fills"("symbol", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "protection_groups_positionBindingId_key" ON "protection_groups"("positionBindingId");

-- CreateIndex
CREATE INDEX "protection_groups_symbol_state_idx" ON "protection_groups"("symbol", "state");

-- CreateIndex
CREATE UNIQUE INDEX "protection_legs_brokerOrderId_key" ON "protection_legs"("brokerOrderId");

-- CreateIndex
CREATE INDEX "protection_legs_groupId_state_idx" ON "protection_legs"("groupId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "protection_legs_groupId_role_key" ON "protection_legs"("groupId", "role");

-- CreateIndex
CREATE INDEX "idempotency_records_operationType_state_idx" ON "idempotency_records"("operationType", "state");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE INDEX "reconciliations_state_startedAt_idx" ON "reconciliations"("state", "startedAt");

-- CreateIndex
CREATE INDEX "reconciliation_discrepancies_reconciliationId_classificatio_idx" ON "reconciliation_discrepancies"("reconciliationId", "classification");

-- CreateIndex
CREATE INDEX "reconciliation_discrepancies_code_createdAt_idx" ON "reconciliation_discrepancies"("code", "createdAt");

-- CreateIndex
CREATE INDEX "recoveries_mode_startedAt_idx" ON "recoveries"("mode", "startedAt");

-- CreateIndex
CREATE INDEX "managed_positions_symbol_closedAt_idx" ON "managed_positions"("symbol", "closedAt");

-- CreateIndex
CREATE INDEX "managed_positions_strategyId_strategyVersion_closedAt_idx" ON "managed_positions"("strategyId", "strategyVersion", "closedAt");

-- CreateIndex
CREATE INDEX "scheduler_configurations_active_idx" ON "scheduler_configurations"("active");

-- CreateIndex
CREATE UNIQUE INDEX "scheduler_executions_idempotencyKey_key" ON "scheduler_executions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "scheduler_executions_startedAt_result_idx" ON "scheduler_executions"("startedAt", "result");

-- CreateIndex
CREATE INDEX "trading_journal_tradeId_occurredAt_idx" ON "trading_journal"("tradeId", "occurredAt");

-- CreateIndex
CREATE INDEX "trading_journal_type_occurredAt_idx" ON "trading_journal"("type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "trading_journal_correlationId_sequence_key" ON "trading_journal"("correlationId", "sequence");

-- CreateIndex
CREATE INDEX "equity_curve_points_capturedAt_idx" ON "equity_curve_points"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "execution_quality_orderId_key" ON "execution_quality"("orderId");

-- CreateIndex
CREATE INDEX "execution_quality_symbol_observedAt_idx" ON "execution_quality"("symbol", "observedAt");

-- CreateIndex
CREATE INDEX "execution_quality_strategyId_observedAt_idx" ON "execution_quality"("strategyId", "observedAt");

-- CreateIndex
CREATE INDEX "execution_quality_orderType_observedAt_idx" ON "execution_quality"("orderType", "observedAt");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tradeIntentId_fkey" FOREIGN KEY ("tradeIntentId") REFERENCES "trade_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_transitions" ADD CONSTRAINT "order_transitions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_legs" ADD CONSTRAINT "protection_legs_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "protection_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "reconciliations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
