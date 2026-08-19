CREATE TYPE "OperationalState" AS ENUM ('READY', 'DEGRADED', 'BLOCKED', 'EMERGENCY');
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "SessionState" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
CREATE TYPE "BackupState" AS ENUM ('STARTED', 'COMPLETED', 'VERIFIED', 'FAILED', 'EXPIRED');

CREATE TABLE "system_state" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "state" "OperationalState" NOT NULL DEFAULT 'BLOCKED',
  "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER',
  "reasonCode" TEXT NOT NULL,
  "reasonDetail" TEXT,
  "changedBy" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "system_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "system_state_singleton" CHECK ("id" = 'singleton'),
  CONSTRAINT "system_state_version_nonnegative" CHECK ("version" >= 0)
);

CREATE TABLE "distributed_locks" (
  "name" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "fencingToken" BIGSERIAL NOT NULL,
  "acquiredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "metadata" JSONB,
  CONSTRAINT "distributed_locks_pkey" PRIMARY KEY ("name"),
  CONSTRAINT "distributed_locks_expiry_after_acquisition" CHECK ("expiresAt" > "acquiredAt")
);

CREATE TABLE "operators" (
  "id" UUID NOT NULL,
  "username" VARCHAR(128) NOT NULL,
  "passwordHash" VARCHAR(512) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMPTZ(6),
  "passwordChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSuccessfulLogin" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "operators_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operators_failed_login_nonnegative" CHECK ("failedLoginCount" >= 0),
  CONSTRAINT "operators_version_nonnegative" CHECK ("version" >= 0)
);

CREATE TABLE "sessions" (
  "id" UUID NOT NULL,
  "operatorId" UUID NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "csrfTokenHash" CHAR(64) NOT NULL,
  "state" "SessionState" NOT NULL DEFAULT 'ACTIVE',
  "ipAddress" VARCHAR(64),
  "userAgent" VARCHAR(512),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sessions_expiry_after_creation" CHECK ("expiresAt" > "createdAt")
);

CREATE TABLE "audit_events" (
  "id" UUID NOT NULL,
  "operatorId" UUID,
  "severity" "AuditSeverity" NOT NULL,
  "action" VARCHAR(128) NOT NULL,
  "resourceType" VARCHAR(128) NOT NULL,
  "resourceId" VARCHAR(256),
  "correlationId" UUID NOT NULL,
  "ipAddress" VARCHAR(64),
  "userAgent" VARCHAR(512),
  "outcome" VARCHAR(64) NOT NULL,
  "metadata" JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "configuration_snapshots" (
  "id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "environment" VARCHAR(32) NOT NULL,
  "tradingMode" "TradingMode" NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "redactedValue" JSONB NOT NULL,
  "deployedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "configuration_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "configuration_version_positive" CHECK ("version" > 0)
);

CREATE TABLE "portfolio_snapshots" (
  "id" UUID NOT NULL,
  "equity" DECIMAL(20,8) NOT NULL,
  "cash" DECIMAL(20,8) NOT NULL,
  "buyingPower" DECIMAL(20,8) NOT NULL,
  "portfolioValue" DECIMAL(20,8) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "brokerTime" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "portfolio_financial_values_nonnegative" CHECK (
    "equity" >= 0 AND "cash" >= 0 AND "buyingPower" >= 0 AND "portfolioValue" >= 0
  )
);

CREATE TABLE "backup_records" (
  "id" UUID NOT NULL,
  "state" "BackupState" NOT NULL,
  "objectKey" VARCHAR(1024) NOT NULL,
  "checksum" CHAR(64),
  "sizeBytes" BIGINT,
  "sourceHost" VARCHAR(255) NOT NULL,
  "offsite" BOOLEAN NOT NULL DEFAULT false,
  "retentionUntil" TIMESTAMPTZ(6) NOT NULL,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "verifiedAt" TIMESTAMPTZ(6),
  "error" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "backup_size_nonnegative" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0),
  CONSTRAINT "backup_retention_after_start" CHECK ("retentionUntil" > "startedAt")
);

CREATE UNIQUE INDEX "operators_username_key" ON "operators"("username");
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");
CREATE UNIQUE INDEX "configuration_snapshots_environment_version_key" ON "configuration_snapshots"("environment", "version");
CREATE UNIQUE INDEX "backup_records_objectKey_key" ON "backup_records"("objectKey");
CREATE INDEX "distributed_locks_expiresAt_idx" ON "distributed_locks"("expiresAt");
CREATE INDEX "sessions_operatorId_state_idx" ON "sessions"("operatorId", "state");
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");
CREATE INDEX "audit_events_occurredAt_idx" ON "audit_events"("occurredAt");
CREATE INDEX "audit_events_correlationId_idx" ON "audit_events"("correlationId");
CREATE INDEX "audit_events_resourceType_resourceId_idx" ON "audit_events"("resourceType", "resourceId");
CREATE INDEX "configuration_snapshots_checksum_idx" ON "configuration_snapshots"("checksum");
CREATE INDEX "portfolio_snapshots_createdAt_idx" ON "portfolio_snapshots"("createdAt");
CREATE INDEX "backup_records_state_retentionUntil_idx" ON "backup_records"("state", "retentionUntil");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
