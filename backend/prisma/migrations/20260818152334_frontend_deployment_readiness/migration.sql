-- CreateTable
CREATE TABLE "strategy_deployments" (
    "id" UUID NOT NULL,
    "strategyId" VARCHAR(128) NOT NULL,
    "fromVersion" VARCHAR(64),
    "toVersion" VARCHAR(64) NOT NULL,
    "deploymentId" VARCHAR(128) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "actor" VARCHAR(128) NOT NULL,
    "reason" TEXT NOT NULL,
    "schedulerStateBefore" VARCHAR(32) NOT NULL,
    "entriesEnabledBefore" BOOLEAN NOT NULL,
    "failure" TEXT,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "strategy_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "strategy_deployments_deploymentId_key" ON "strategy_deployments"("deploymentId");

-- CreateIndex
CREATE INDEX "strategy_deployments_strategyId_startedAt_idx" ON "strategy_deployments"("strategyId", "startedAt");

-- CreateIndex
CREATE INDEX "strategy_deployments_state_startedAt_idx" ON "strategy_deployments"("state", "startedAt");
