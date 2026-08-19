import type { AppConfig } from '../core/config.js';
import type { DatabaseClient } from '../database/client.js';
import { createRiskConfigurationSnapshot } from '../risk/config.js';
import type { LiveReadinessEvidenceSet, LiveRuntimeContext } from './service.js';

export async function collectRuntimeReadinessEvidence(
  database: DatabaseClient,
): Promise<LiveReadinessEvidenceSet> {
  const now = new Date();
  const [
    reconciliation,
    startupReconciliation,
    recovery,
    alertDelivery,
    backup,
    safety,
    risk,
    unknownOrders,
    riskDecisions,
    schedulerRuns,
    worker,
    marketStates,
    clock,
    breakers,
    executionQuality,
    fillStats,
    partialFills,
    killSwitchDrill,
    onlyCloseDrill,
    backtest,
    strategyVersions,
    validations,
  ] = await Promise.all([
    database.reconciliationRecord.findFirst({
      orderBy: { startedAt: 'desc' },
      include: { discrepancies: true },
    }),
    database.reconciliationRecord.findFirst({
      where: { trigger: 'STARTUP' },
      orderBy: { startedAt: 'desc' },
    }),
    database.recoveryRecord.findFirst({ orderBy: { startedAt: 'desc' } }),
    database.alertDeliveryRecord.findFirst({
      where: { outcome: 'SENT' },
      orderBy: { attemptedAt: 'desc' },
    }),
    database.backupRecord.findFirst({
      where: { state: 'VERIFIED', offsite: true },
      orderBy: { verifiedAt: 'desc' },
    }),
    database.safetyStateRecord.findUnique({ where: { id: 'singleton' } }),
    database.riskConfigurationRecord.findFirst({
      where: { active: true },
      orderBy: { activatedAt: 'desc' },
    }),
    database.orderRecord.count({ where: { state: 'UNKNOWN' } }),
    database.riskDecisionRecord.count(),
    database.schedulerExecutionRecord.count({ where: { result: 'COMPLETED' } }),
    database.workerHeartbeatRecord.findFirst({
      where: { kind: 'TRADING_SCHEDULER' },
      orderBy: { heartbeatAt: 'desc' },
    }),
    database.marketDataStateRecord.findMany(),
    database.marketClockRecord.findUnique({ where: { id: 'singleton' } }),
    database.circuitBreakerRecord.findMany(),
    database.executionQualityRecord.count(),
    database.fillRecord.aggregate({
      _count: { id: true },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    }),
    database.orderRecord.count({ where: { state: 'PARTIALLY_FILLED' } }),
    database.safetyAuditRecord.findFirst({
      where: { action: 'KILL_SWITCH' },
      orderBy: { occurredAt: 'desc' },
    }),
    database.safetyAuditRecord.findFirst({
      where: { action: 'DISABLE_ENTRIES' },
      orderBy: { occurredAt: 'desc' },
    }),
    database.backtestJobRecord.findFirst({
      where: { status: 'COMPLETED', datasetHash: { not: null } },
      orderBy: { finishedAt: 'desc' },
    }),
    database.strategyVersionRecord.findMany({ where: { lifecycle: 'ACTIVE' } }),
    database.auditEvent.findMany({
      where: {
        action: { startsWith: 'VALIDATION_' },
        outcome: 'SUCCEEDED',
        occurredAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
      },
      orderBy: { occurredAt: 'desc' },
    }),
  ]);
  const reconciliationPassed =
    reconciliation?.state === 'MATCHED' || reconciliation?.state === 'CORRECTED';
  const startupPassed =
    startupReconciliation?.state === 'MATCHED' || startupReconciliation?.state === 'CORRECTED';
  const runtimeFresh = (value: Date | null | undefined, maximumAgeMs: number): boolean =>
    value !== null && value !== undefined && now.getTime() - value.getTime() <= maximumAgeMs;
  const riskChecksumValid = (() => {
    if (!risk) return false;
    try {
      return (
        createRiskConfigurationSnapshot(risk.configuration, risk.createdAt).checksum ===
        risk.checksum
      );
    } catch {
      return false;
    }
  })();
  const healthyMarketData =
    marketStates.length > 0 &&
    marketStates.every(
      (state) =>
        state.health === 'HEALTHY' &&
        runtimeFresh(state.lastBarAt, 120_000) &&
        runtimeFresh(state.lastQuoteAt, 120_000) &&
        runtimeFresh(state.lastTradeAt, 120_000),
    );
  const successfulReconciliation =
    reconciliation !== null &&
    reconciliationPassed &&
    runtimeFresh(reconciliation.finishedAt, 120_000) &&
    reconciliation.discrepancies.every(
      (item) => item.classification !== 'BLOCKING' || item.resolvedAt !== null,
    );
  const validation = (name: string) =>
    validations.find((event) => {
      if (
        event.action !== `VALIDATION_${name}` ||
        !event.resourceId ||
        !/^[a-f0-9]{64}$/i.test(event.resourceId) ||
        event.metadata === null ||
        typeof event.metadata !== 'object' ||
        Array.isArray(event.metadata)
      )
        return false;
      const metadata = event.metadata as Record<string, unknown>;
      return (
        metadata.artifactSha256 === event.resourceId.toLowerCase() &&
        typeof metadata.detail === 'string' &&
        metadata.detail.length >= 20 &&
        typeof metadata.executedAt === 'string' &&
        typeof metadata.sourceEnvironment === 'string'
      );
    });
  const fillCount = fillStats._count.id;
  const soakDays =
    fillStats._min.occurredAt && fillStats._max.occurredAt
      ? (fillStats._max.occurredAt.getTime() - fillStats._min.occurredAt.getTime()) / 86_400_000
      : 0;
  const partialFillValidation = validation('PARTIAL_FILL');
  const cancelFillRaceValidation = validation('CANCEL_FILL_RACE');
  const backtestValidation = validation('BACKTEST_ENGINE');
  const paperSoakValidation = validation('PAPER_SOAK');
  const killSwitchValidation = validation('KILL_SWITCH');
  const recoveryValidation = validation('RECOVERY');
  const midSessionRestartValidation = validation('MID_SESSION_RESTART');
  const restoreValidation = validation('RESTORE');
  const alertWatchdogValidation = validation('ALERT_WATCHDOG');
  const brokerOutageValidation = validation('BROKER_OUTAGE');
  const marketDataOutageValidation = validation('MARKET_DATA_OUTAGE');
  const databaseOutageValidation = validation('DATABASE_OUTAGE');
  const recoveryCompleted = recovery?.finishedAt !== null && recovery?.finishedAt !== undefined;
  return {
    PAPER_LIVE_GUARD: {
      passed: safety !== null && safety.tradingMode === 'LIVE',
      evidence: safety
        ? `Persisted safety mode is ${safety.tradingMode}; LIVE configuration remains fail-closed`
        : 'No persisted safety state exists',
    },
    UNKNOWN_ORDER_HANDLING: {
      passed: unknownOrders === 0 && successfulReconciliation,
      evidence: `${unknownOrders} unresolved UNKNOWN orders; reconciliation evidence=${successfulReconciliation}`,
    },
    IDEMPOTENCY: {
      passed: schedulerRuns > 0,
      evidence: `${schedulerRuns} completed persistently idempotent scheduler runs`,
    },
    RISK_MANAGEMENT: {
      passed: riskChecksumValid && riskDecisions > 0,
      evidence: `risk checksum valid=${riskChecksumValid}; persisted decisions=${riskDecisions}`,
    },
    POSITION_SIZING: {
      passed: riskDecisions > 0,
      evidence: `${riskDecisions} persisted final risk/sizing decisions`,
    },
    OPERATIONAL_SAFETY: {
      passed: safety !== null && safety.blocks instanceof Array,
      evidence: safety ? `Safety state version ${safety.version}` : 'Safety state missing',
    },
    KILL_SWITCH: {
      passed: killSwitchDrill !== null,
      evidence: killSwitchDrill
        ? `Kill switch exercised at ${killSwitchDrill.occurredAt.toISOString()}`
        : 'Kill switch has not been exercised in this deployment',
    },
    ONLY_CLOSE: {
      passed: onlyCloseDrill !== null,
      evidence: onlyCloseDrill
        ? `ONLY_CLOSE exercised at ${onlyCloseDrill.occurredAt.toISOString()}`
        : 'ONLY_CLOSE has not been exercised in this deployment',
    },
    CIRCUIT_BREAKERS: {
      passed: breakers.length > 0 && breakers.every((breaker) => breaker.state === 'CLOSED'),
      evidence: `${breakers.length} persistent breakers; ${breakers.filter((item) => item.state !== 'CLOSED').length} open`,
    },
    PRICE_SANITY: {
      passed: healthyMarketData,
      evidence: `${marketStates.length} symbols with independent bar/quote/trade freshness`,
    },
    LIQUIDITY_GUARD: {
      passed: riskChecksumValid,
      evidence: riskChecksumValid
        ? 'Active immutable risk limits checksum verified'
        : 'Risk limits unavailable',
    },
    SLIPPAGE_GUARD: {
      passed: executionQuality > 0,
      evidence: `${executionQuality} execution-quality measurements`,
    },
    SCHEDULER_SAFETY: {
      passed:
        schedulerRuns > 0 &&
        worker !== null &&
        runtimeFresh(worker.heartbeatAt, 20_000) &&
        worker.status !== 'FAILED',
      evidence: `${schedulerRuns} completed runs; worker=${worker?.status ?? 'missing'}`,
    },
    FILLS_AND_PARTIAL_FILLS: {
      passed: fillCount > 0 && (partialFills > 0 || partialFillValidation !== undefined),
      evidence: `${fillCount} fills; partial-fill evidence=${partialFills > 0 || partialFillValidation !== undefined}`,
    },
    CANCEL_FILL_RACES: {
      passed: cancelFillRaceValidation !== undefined,
      evidence: cancelFillRaceValidation
        ? `Validated at ${cancelFillRaceValidation.occurredAt.toISOString()}`
        : 'No cancel/fill race drill evidence exists',
    },
    EXTERNAL_BROKER_ACTIVITY: {
      passed: successfulReconciliation,
      evidence: successfulReconciliation
        ? `Latest reconciliation ${reconciliation.id} has no unresolved blocking discrepancies`
        : 'External broker activity has not been cleared by a fresh reconciliation',
    },
    RECONCILIATION_END_TO_END: {
      passed: reconciliationPassed,
      evidence: reconciliationPassed
        ? `Latest reconciliation ${reconciliation.id} finished ${reconciliation.state}`
        : 'No successful broker-authoritative reconciliation is recorded',
    },
    STARTUP_RECONCILIATION: {
      passed: startupPassed,
      evidence: startupPassed
        ? `Startup reconciliation ${startupReconciliation.id} finished ${startupReconciliation.state}`
        : 'No successful STARTUP reconciliation is recorded',
    },
    CRASH_RECOVERY: {
      passed: recoveryCompleted,
      evidence:
        recovery?.finishedAt === null || recovery === null
          ? 'No completed recovery run is recorded'
          : `Recovery ${recovery.id} completed at ${recovery.finishedAt.toISOString()}`,
    },
    CRITICAL_ALERT_DELIVERY: {
      passed: alertDelivery !== null,
      evidence:
        alertDelivery === null
          ? 'No successful external alert delivery is recorded'
          : `Alert delivery ${alertDelivery.id} succeeded over ${alertDelivery.channel}`,
    },
    BACKUP_AND_DISASTER_RECOVERY: {
      passed: backup !== null,
      evidence:
        backup === null
          ? 'No verified offsite backup record is available in this deployment'
          : `Verified offsite backup ${backup.objectKey} (${backup.checksum ?? 'checksum missing'})`,
    },
    BACKTEST_ENGINE_VALIDATED: {
      passed: backtest !== null && backtestValidation !== undefined,
      evidence:
        backtest && backtestValidation
          ? `Backtest job ${backtest.id} dataset ${backtest.datasetHash}; validation ${backtestValidation.id}`
          : 'A reproducible backtest and independent backtest-engine validation are required',
    },
    PAPER_SOAK_COMPLETED: {
      passed: (fillCount >= 100 && soakDays >= 28) || paperSoakValidation !== undefined,
      evidence:
        fillCount >= 100 && soakDays >= 28
          ? `${fillCount} local PAPER fills spanning ${soakDays.toFixed(1)} calendar days`
          : paperSoakValidation
            ? `Qualified PAPER evidence ${paperSoakValidation.resourceId} attested at ${paperSoakValidation.occurredAt.toISOString()}`
            : `${fillCount} local fills spanning ${soakDays.toFixed(1)} days; a fresh qualified PAPER artifact is required for an isolated LIVE deployment`,
    },
    ZERO_UNKNOWN_ORDERS: {
      passed: unknownOrders === 0,
      evidence: `${unknownOrders} unresolved UNKNOWN orders`,
    },
    ZERO_RECONCILIATION_DISCREPANCIES: {
      passed: successfulReconciliation,
      evidence: successfulReconciliation
        ? 'Fresh reconciliation has no blocking discrepancy'
        : 'Reconciliation is stale, failed, or blocked',
    },
    KILL_SWITCH_DRILL: {
      passed: killSwitchDrill !== null && killSwitchValidation !== undefined,
      evidence: killSwitchValidation
        ? `Validated at ${killSwitchValidation.occurredAt.toISOString()}`
        : 'Kill-switch drill not attested',
    },
    RECOVERY_DRILL: {
      passed: recoveryCompleted && recoveryValidation !== undefined,
      evidence: recoveryValidation
        ? `Validated at ${recoveryValidation.occurredAt.toISOString()}`
        : 'Recovery drill not attested',
    },
    MID_SESSION_RESTART_DRILL: drillEvidence(midSessionRestartValidation),
    RESTORE_DRILL: {
      passed: backup !== null && restoreValidation !== undefined,
      evidence: restoreValidation
        ? `Validated at ${restoreValidation.occurredAt.toISOString()}`
        : 'Restore drill not attested',
    },
    ALERT_WATCHDOG_DRILL: {
      passed: alertDelivery !== null && alertWatchdogValidation !== undefined,
      evidence: alertWatchdogValidation
        ? `Validated at ${alertWatchdogValidation.occurredAt.toISOString()}`
        : 'External watchdog drill not attested',
    },
    BROKER_OUTAGE_DRILL: drillEvidence(brokerOutageValidation),
    MARKET_DATA_OUTAGE_DRILL: drillEvidence(marketDataOutageValidation),
    DATABASE_OUTAGE_DRILL: drillEvidence(databaseOutageValidation),
    CLOCK_HEALTH: {
      passed: clock !== null && runtimeFresh(clock.observedAt, 120_000),
      evidence: clock
        ? `Broker clock observed ${clock.observedAt.toISOString()}`
        : 'Broker clock missing',
    },
    WORKER_HEARTBEAT: {
      passed: worker !== null && runtimeFresh(worker.heartbeatAt, 20_000),
      evidence: worker
        ? `Worker ${worker.id} ${worker.status} at ${worker.heartbeatAt.toISOString()}`
        : 'Worker heartbeat missing',
    },
    MIGRATIONS_CURRENT: await migrationEvidence(database),
    STRATEGY_DEPLOYMENT_APPROVED: {
      passed:
        strategyVersions.length > 0 &&
        strategyVersions.every(
          (version) => version.commitSha !== null && version.buildChecksum !== null,
        ),
      evidence: `${strategyVersions.length} active strategy versions with release provenance`,
    },
  };
}

function drillEvidence(event: { id: string; occurredAt: Date } | undefined) {
  return {
    passed: event !== undefined,
    evidence: event
      ? `Validated by audit ${event.id} at ${event.occurredAt.toISOString()}`
      : 'No drill evidence exists',
  };
}

async function migrationEvidence(database: DatabaseClient) {
  const expected = [
    '20260818100000_foundation',
    '20260818132657_market_foundation',
    '20260818141556_decision_risk_foundation',
    '20260818143802_execution_operations_foundation',
    '20260818145432_backtest_observability_remote',
    '20260818152334_frontend_deployment_readiness',
    '20260818153738_final_live_readiness',
    '20260819090000_runtime_production_foundation',
  ] as const;
  try {
    const rows = await database.$queryRaw<
      { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
    >`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY migration_name
    `;
    const applied = new Set(
      rows
        .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
        .map((row) => row.migration_name),
    );
    const missing = expected.filter((name) => !applied.has(name));
    const incomplete = rows.filter(
      (row) => row.finished_at === null || row.rolled_back_at !== null,
    ).length;
    return {
      passed: missing.length === 0 && incomplete === 0,
      evidence: `${applied.size}/${expected.length} expected migrations; missing=${missing.join(',') || 'none'}; incomplete=${incomplete}`,
    };
  } catch {
    return { passed: false, evidence: 'Prisma migration history could not be verified' };
  }
}

export async function collectLiveRuntimeContext(
  database: DatabaseClient,
  config: AppConfig,
  brokerAccountIsLive = false,
): Promise<LiveRuntimeContext> {
  const [portfolio, risk, brokerRequest] = await Promise.all([
    database.portfolioSnapshot.findFirst({ orderBy: { createdAt: 'desc' } }),
    database.riskConfigurationRecord.findFirst({
      where: { active: true },
      orderBy: { activatedAt: 'desc' },
    }),
    database.brokerRequestRecord.findFirst({
      where: { service: 'trading', outcome: 'SUCCEEDED' },
      orderBy: { occurredAt: 'desc' },
    }),
  ]);
  const riskValue =
    risk?.configuration &&
    typeof risk.configuration === 'object' &&
    !Array.isArray(risk.configuration)
      ? (risk.configuration as Record<string, unknown>)
      : {};
  const number = (key: string): number => {
    const value = riskValue[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  const liveHost = new URL(config.alpaca.liveBaseUrl).hostname;
  const paperHost = new URL(config.alpaca.paperBaseUrl).hostname;
  const endpointVerifiedLive =
    config.trading.mode === 'LIVE' &&
    liveHost !== paperHost &&
    !liveHost.toLowerCase().includes('paper') &&
    portfolio?.accountStatus === 'ACTIVE' &&
    brokerRequest !== null &&
    Date.now() - brokerRequest.occurredAt.getTime() <= 60_000;
  return {
    environment: config.app.environment,
    tradingMode: config.trading.mode,
    brokerConnectivityEnabled: config.trading.brokerConnectivityEnabled,
    liveTradingEnabled: config.trading.liveTradingEnabled,
    hasLiveCredentials:
      config.alpaca.liveKey !== undefined && config.alpaca.liveSecret !== undefined,
    brokerAccountIsLive: brokerAccountIsLive || endpointVerifiedLive,
    accountEquityUsd: portfolio?.equity.toNumber() ?? 0,
    initialRiskLimitsApplied:
      number('maximumOrderNotional') <= 100 &&
      number('maximumTotalCapital') <= 500 &&
      number('dailyLossLimitAmount') <= 25 &&
      number('maximumDrawdownPercent') <= 3,
    externalSecretsProvider: config.trading.secretsProvider !== 'env',
    mfaConfigured: config.security.operatorTotpSecret !== undefined,
    externalAlertConfigured:
      config.alerts.telegramBotToken !== undefined && config.alerts.telegramChatId !== undefined,
  };
}
