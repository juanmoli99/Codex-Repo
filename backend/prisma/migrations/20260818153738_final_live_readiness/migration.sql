-- CreateEnum
CREATE TYPE "LiveReadinessState" AS ENUM ('NOT_READY', 'READY_FOR_ACTIVATION', 'ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "live_readiness" (
    "id" UUID NOT NULL,
    "state" "LiveReadinessState" NOT NULL DEFAULT 'NOT_READY',
    "tradingMode" "TradingMode" NOT NULL,
    "environment" VARCHAR(32) NOT NULL,
    "configurationChecksum" CHAR(64) NOT NULL,
    "limits" JSONB NOT NULL,
    "failureCodes" JSONB NOT NULL,
    "assessedBy" VARCHAR(128) NOT NULL,
    "assessedAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "activatedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "live_readiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_readiness_checks" (
    "id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "code" VARCHAR(96) NOT NULL,
    "requirement" INTEGER NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "passed" BOOLEAN NOT NULL,
    "evidence" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_readiness_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_activations" (
    "id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "actor" VARCHAR(128) NOT NULL,
    "nonceHash" CHAR(64) NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "failureCode" VARCHAR(96),
    "challengeExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "manualMonitoringUntil" TIMESTAMPTZ(6),
    "limits" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_activations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "live_readiness_state_assessedAt_idx" ON "live_readiness"("state", "assessedAt");

-- CreateIndex
CREATE INDEX "live_readiness_checks_code_passed_checkedAt_idx" ON "live_readiness_checks"("code", "passed", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "live_readiness_checks_assessmentId_code_key" ON "live_readiness_checks"("assessmentId", "code");

-- CreateIndex
CREATE INDEX "live_activations_assessmentId_outcome_createdAt_idx" ON "live_activations"("assessmentId", "outcome", "createdAt");

-- CreateIndex
CREATE INDEX "live_activations_challengeExpiresAt_consumedAt_idx" ON "live_activations"("challengeExpiresAt", "consumedAt");

-- AddForeignKey
ALTER TABLE "live_readiness_checks" ADD CONSTRAINT "live_readiness_checks_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "live_readiness"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_activations" ADD CONSTRAINT "live_activations_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "live_readiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
