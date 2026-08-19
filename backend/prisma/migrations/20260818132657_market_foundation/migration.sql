-- CreateEnum
CREATE TYPE "MarketDataHealth" AS ENUM ('HEALTHY', 'STALE', 'UNAVAILABLE', 'INCONSISTENT');

-- CreateEnum
CREATE TYPE "CorporateActionState" AS ENUM ('PENDING', 'EFFECTIVE', 'RECONCILING', 'RECONCILED', 'AMBIGUOUS');

-- CreateEnum
CREATE TYPE "EventTiming" AS ENUM ('PRE_MARKET', 'POST_MARKET', 'DURING_MARKET', 'UNKNOWN');

-- CreateTable
CREATE TABLE "broker_request_records" (
    "id" UUID NOT NULL,
    "correlationId" UUID NOT NULL,
    "brokerRequestId" VARCHAR(256),
    "service" VARCHAR(32) NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "path" VARCHAR(512) NOT NULL,
    "statusCode" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "retryAttempt" INTEGER NOT NULL DEFAULT 1,
    "outcome" VARCHAR(64) NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_request_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_rule_versions" (
    "id" VARCHAR(128) NOT NULL,
    "regime" VARCHAR(64) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveUntil" DATE,
    "rules" JSONB NOT NULL,
    "source" VARCHAR(512) NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regulatory_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data_states" (
    "symbol" VARCHAR(32) NOT NULL,
    "health" "MarketDataHealth" NOT NULL DEFAULT 'UNAVAILABLE',
    "lastValidTimestamp" TIMESTAMPTZ(6),
    "warmupBarsObserved" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "market_data_states_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "market_data_anomalies" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "code" VARCHAR(128) NOT NULL,
    "severity" VARCHAR(32) NOT NULL,
    "detail" TEXT NOT NULL,
    "dataTime" TIMESTAMPTZ(6),
    "detectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" UUID,

    CONSTRAINT "market_data_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "name" TEXT NOT NULL,
    "assetClass" VARCHAR(64) NOT NULL,
    "exchange" VARCHAR(64) NOT NULL,
    "status" VARCHAR(64) NOT NULL,
    "tradable" BOOLEAN NOT NULL,
    "fractionable" BOOLEAN NOT NULL,
    "shortable" BOOLEAN NOT NULL,
    "marginable" BOOLEAN NOT NULL,
    "attributes" JSONB NOT NULL,
    "brokerUpdatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symbol_blocks" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "reason" VARCHAR(256) NOT NULL,
    "source" VARCHAR(128) NOT NULL,
    "blockedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6),
    "releasedAt" TIMESTAMPTZ(6),

    CONSTRAINT "symbol_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "halt_events" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "statusCode" VARCHAR(32) NOT NULL,
    "statusMessage" TEXT NOT NULL,
    "reasonCode" VARCHAR(32),
    "reasonMessage" TEXT,
    "eventTime" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumedAt" TIMESTAMPTZ(6),
    "luldUpper" DECIMAL(20,8),
    "luldLower" DECIMAL(20,8),
    "raw" JSONB NOT NULL,

    CONSTRAINT "halt_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_actions" (
    "id" VARCHAR(128) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "state" "CorporateActionState" NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "newSymbol" VARCHAR(32),
    "effectiveAt" TIMESTAMPTZ(6) NOT NULL,
    "quantityRatio" DECIMAL(30,12),
    "cashAmount" DECIMAL(20,8),
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "corporate_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_action_adjustments" (
    "id" UUID NOT NULL,
    "actionId" VARCHAR(128) NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(256) NOT NULL,
    "operation" VARCHAR(128) NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corporate_action_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_events" (
    "id" VARCHAR(128) NOT NULL,
    "symbol" VARCHAR(32),
    "type" VARCHAR(64) NOT NULL,
    "scheduledAt" TIMESTAMPTZ(6) NOT NULL,
    "timing" "EventTiming" NOT NULL,
    "source" VARCHAR(128) NOT NULL,
    "sourceVersion" VARCHAR(128) NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "market_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_policy_applications" (
    "id" UUID NOT NULL,
    "policyId" VARCHAR(128) NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "eventId" VARCHAR(128),
    "evaluatedAt" TIMESTAMPTZ(6) NOT NULL,
    "timeToEventMs" BIGINT,
    "entryAllowed" BOOLEAN NOT NULL,
    "positionSizeMultiplier" DECIMAL(8,6) NOT NULL,
    "overnightAllowed" BOOLEAN NOT NULL,
    "reasons" JSONB NOT NULL,
    "configurationSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_policy_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broker_request_records_correlationId_idx" ON "broker_request_records"("correlationId");

-- CreateIndex
CREATE INDEX "broker_request_records_brokerRequestId_idx" ON "broker_request_records"("brokerRequestId");

-- CreateIndex
CREATE INDEX "broker_request_records_occurredAt_idx" ON "broker_request_records"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_rule_versions_checksum_key" ON "regulatory_rule_versions"("checksum");

-- CreateIndex
CREATE INDEX "regulatory_rule_versions_effectiveFrom_effectiveUntil_idx" ON "regulatory_rule_versions"("effectiveFrom", "effectiveUntil");

-- CreateIndex
CREATE INDEX "market_data_states_health_idx" ON "market_data_states"("health");

-- CreateIndex
CREATE INDEX "market_data_anomalies_symbol_detectedAt_idx" ON "market_data_anomalies"("symbol", "detectedAt");

-- CreateIndex
CREATE INDEX "market_data_anomalies_code_severity_idx" ON "market_data_anomalies"("code", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "assets_symbol_key" ON "assets"("symbol");

-- CreateIndex
CREATE INDEX "assets_status_tradable_idx" ON "assets"("status", "tradable");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_assetId_key" ON "watchlist"("assetId");

-- CreateIndex
CREATE INDEX "watchlist_active_idx" ON "watchlist"("active");

-- CreateIndex
CREATE INDEX "symbol_blocks_assetId_expiresAt_releasedAt_idx" ON "symbol_blocks"("assetId", "expiresAt", "releasedAt");

-- CreateIndex
CREATE INDEX "halt_events_symbol_eventTime_idx" ON "halt_events"("symbol", "eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "halt_events_symbol_statusCode_eventTime_key" ON "halt_events"("symbol", "statusCode", "eventTime");

-- CreateIndex
CREATE INDEX "corporate_actions_symbol_effectiveAt_idx" ON "corporate_actions"("symbol", "effectiveAt");

-- CreateIndex
CREATE INDEX "corporate_actions_state_idx" ON "corporate_actions"("state");

-- CreateIndex
CREATE INDEX "corporate_action_adjustments_entityType_entityId_idx" ON "corporate_action_adjustments"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_action_adjustments_actionId_entityType_entityId_o_key" ON "corporate_action_adjustments"("actionId", "entityType", "entityId", "operation");

-- CreateIndex
CREATE INDEX "market_events_symbol_type_scheduledAt_idx" ON "market_events"("symbol", "type", "scheduledAt");

-- CreateIndex
CREATE INDEX "event_policy_applications_strategyId_symbol_evaluatedAt_idx" ON "event_policy_applications"("strategyId", "symbol", "evaluatedAt");

-- AddForeignKey
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symbol_blocks" ADD CONSTRAINT "symbol_blocks_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_action_adjustments" ADD CONSTRAINT "corporate_action_adjustments_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "corporate_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
