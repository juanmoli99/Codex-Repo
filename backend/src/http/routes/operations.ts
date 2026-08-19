import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { InputValidationError } from '../../core/errors.js';
import { marketLocalToUtc } from '../../market-data/calendar.js';
import { verifyTotp } from '../../security/totp.js';
import { sessionCookieName } from '../session-cookie.js';
import type { AppDependencies } from '../types.js';

const actionSchema = z
  .object({
    confirmation: z.string().optional(),
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9.-]{0,9}$/)
      .optional(),
    active: z.boolean().optional(),
    positionId: z.uuid().optional(),
    orderId: z.uuid().optional(),
    reauthenticationPassword: z.string().min(16).max(1_024).optional(),
    totpCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    riskConfiguration: z.unknown().optional(),
    blockId: z.uuid().optional(),
    checks: z.record(z.string(), z.boolean()).optional(),
    strategy: z.string().min(1).max(128).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    initialCapital: z.number().min(1_000).max(10_000_000).optional(),
    backtestJobId: z.uuid().optional(),
    alertId: z.uuid().optional(),
    validationKind: z
      .enum([
        'BACKTEST_ENGINE',
        'MARKET_DATA_ONLY',
        'PAPER_ORDERS',
        'PAPER_SOAK',
        'PARTIAL_FILL',
        'CANCEL_FILL_RACE',
        'KILL_SWITCH',
        'RECOVERY',
        'MID_SESSION_RESTART',
        'RESTORE',
        'ALERT_WATCHDOG',
        'BROKER_OUTAGE',
        'MARKET_DATA_OUTAGE',
        'DATABASE_OUTAGE',
      ])
      .optional(),
    artifactSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    evidenceDetail: z.string().trim().min(20).max(4_000).optional(),
    evidenceExecutedAt: z.iso.datetime({ offset: true }).optional(),
    sourceEnvironment: z.string().trim().min(3).max(128).optional(),
  })
  .loose();

function csrfHeader(request: FastifyRequest): string | undefined {
  const value = request.headers['x-csrf-token'];
  return Array.isArray(value) ? value[0] : value;
}

function jsonField(value: unknown, key: string, fallback: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' || typeof candidate === 'number'
    ? String(candidate)
    : fallback;
}

function asIso(value: Date | null | undefined): string | undefined {
  return value?.toISOString();
}

function actionRequiresStrongConfirmation(action: string): boolean {
  return [
    'kill-switch',
    'entries-disable',
    'scheduler-stop',
    'position-close',
    'order-cancel',
    'risk-edit',
    'safety-recover',
    'alert-ack',
    'validation-attest',
  ].includes(action);
}

export function registerOperationsRoutes(
  server: FastifyInstance,
  dependencies: AppDependencies,
): void {
  const sessionCookie = sessionCookieName(dependencies.config);
  server.post('/api/backtests/jobs', async (request, reply) => {
    const session = await dependencies.authService.authenticateWithCsrf(
      request.cookies[sessionCookie],
      csrfHeader(request),
    );
    const input = z
      .object({
        symbol: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
        strategyId: z.string().min(1).max(128),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        initialCapital: z.number().min(1_000).max(10_000_000).optional(),
      })
      .parse(request.body);
    const result = await dependencies.operationsRuntime.startBacktest(
      {
        symbol: input.symbol,
        strategyId: input.strategyId,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.initialCapital === undefined ? {} : { initialCapital: input.initialCapital }),
      },
      {
        actor: session.operatorId,
        correlationId: request.id,
      },
    );
    return reply.code(202).send(result);
  });

  server.get('/api/backtests/jobs/:jobId', async (request) => {
    await dependencies.authService.authenticate(request.cookies[sessionCookie]);
    const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
    return dependencies.operationsRuntime.getBacktestJob(jobId);
  });

  server.delete('/api/backtests/jobs/:jobId', async (request, reply) => {
    const session = await dependencies.authService.authenticateWithCsrf(
      request.cookies[sessionCookie],
      csrfHeader(request),
    );
    const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
    const result = await dependencies.operationsRuntime.cancelBacktest(jobId, {
      actor: session.operatorId,
      correlationId: request.id,
    });
    return reply.code(202).send(result);
  });

  server.get('/api/operations/snapshot', async (request) => {
    await dependencies.authService.authenticate(request.cookies[sessionCookie]);
    const database = dependencies.database;
    const [
      safety,
      portfolio,
      equityPoint,
      positions,
      orders,
      alerts,
      watchlist,
      scans,
      riskConfiguration,
      riskDecisions,
      safetyAudit,
      schedulerState,
      schedulerExecutions,
      backtests,
      auditEvents,
      reconciliations,
      latestBrokerRequest,
      marketDataStates,
      marketClock,
      fills,
      dailyDispositions,
      activeSymbolBlocks,
      circuitBreakers,
      schedulerConfiguration,
      workerHeartbeat,
      backtestJobs,
    ] = await Promise.all([
      database.safetyStateRecord.findUnique({ where: { id: 'singleton' } }),
      database.portfolioSnapshot.findFirst({
        orderBy: { createdAt: 'desc' },
        include: { positions: true },
      }),
      database.equityCurvePointRecord.findFirst({ orderBy: { capturedAt: 'desc' } }),
      database.managedPositionRecord.findMany({
        where: { closedAt: null },
        orderBy: { openedAt: 'desc' },
        take: 100,
      }),
      database.orderRecord.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 100,
        include: { transitions: { orderBy: { sequence: 'asc' } } },
      }),
      database.alertRecord.findMany({ orderBy: { lastOccurredAt: 'desc' }, take: 100 }),
      database.watchlistRecord.findMany({
        orderBy: { createdAt: 'asc' },
        include: { asset: { include: { blocks: { orderBy: { blockedAt: 'desc' }, take: 1 } } } },
      }),
      database.scannerExecutionRecord.findMany({
        orderBy: { startedAt: 'desc' },
        take: 25,
        include: { results: true },
      }),
      database.riskConfigurationRecord.findFirst({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
      }),
      database.riskDecisionRecord.findMany({
        where: { outcome: 'REJECTED' },
        orderBy: { evaluatedAt: 'desc' },
        take: 15,
      }),
      database.safetyAuditRecord.findMany({ orderBy: { occurredAt: 'desc' }, take: 30 }),
      database.schedulerStateRecord.findUnique({ where: { id: 'singleton' } }),
      database.schedulerExecutionRecord.findMany({ orderBy: { startedAt: 'desc' }, take: 25 }),
      database.backtestRunRecord.findMany({
        orderBy: { finishedAt: 'desc' },
        take: 20,
        include: { equityCurve: { orderBy: { timestamp: 'asc' } } },
      }),
      database.auditEvent.findMany({ orderBy: { occurredAt: 'desc' }, take: 100 }),
      database.reconciliationRecord.findMany({
        orderBy: { startedAt: 'desc' },
        take: 20,
        include: { discrepancies: true },
      }),
      database.brokerRequestRecord.findFirst({ orderBy: { occurredAt: 'desc' } }),
      database.marketDataStateRecord.findMany({ take: 1_000 }),
      database.marketClockRecord.findUnique({ where: { id: 'singleton' } }),
      database.fillRecord.findMany({
        orderBy: { occurredAt: 'desc' },
        take: 100,
        include: { order: { include: { intent: true } } },
      }),
      database.lotDispositionRecord.findMany({
        where: { soldAt: { gte: startOfCurrentMarketDay() } },
      }),
      database.symbolBlockRecord.findMany({
        where: {
          releasedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        include: { asset: true },
        orderBy: { blockedAt: 'desc' },
      }),
      database.circuitBreakerRecord.findMany({
        where: { state: { not: 'CLOSED' } },
        orderBy: { updatedAt: 'desc' },
      }),
      database.schedulerConfigurationRecord.findFirst({
        where: { active: true },
        orderBy: { updatedAt: 'desc' },
      }),
      database.workerHeartbeatRecord.findFirst({
        where: { kind: 'TRADING_SCHEDULER' },
        orderBy: { heartbeatAt: 'desc' },
      }),
      database.backtestJobRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);

    const operational = dependencies.operationalState.current();
    const now = new Date();
    const cash = portfolio?.cash.toString() ?? '0';
    const equity = portfolio?.equity.toString() ?? '0';
    const buyingPower = portfolio?.buyingPower.toString() ?? '0';
    const portfolioPositions = portfolio?.positions ?? [];
    const currentExposure = portfolioPositions.reduce(
      (sum, position) => sum + position.marketValue.abs().toNumber(),
      0,
    );
    const exposurePercent = Number(equity) > 0 ? (currentExposure / Number(equity)) * 100 : 0;
    const riskJson = riskConfiguration?.configuration;
    const maximumExposure = jsonField(riskJson, 'maximumGlobalExposurePercent', '50');
    const latestReconciliation = reconciliations[0];
    const unhealthyMarketData = marketDataStates.filter((state) => state.health !== 'HEALTHY');
    const workerFresh =
      workerHeartbeat !== null &&
      now.getTime() - workerHeartbeat.heartbeatAt.getTime() <
        dependencies.config.runtime.workerDeadAfterMs;
    const schedulerHealth =
      schedulerState === null || workerHeartbeat === null
        ? 'UNKNOWN'
        : schedulerState.state === 'RUNNING' && workerFresh
          ? 'UP'
          : 'DEGRADED';
    const brokerFresh =
      latestBrokerRequest !== null &&
      now.getTime() - latestBrokerRequest.occurredAt.getTime() < 60_000;
    const reconciliationFresh =
      latestReconciliation?.finishedAt !== null &&
      latestReconciliation?.finishedAt !== undefined &&
      now.getTime() - latestReconciliation.finishedAt.getTime() <
        dependencies.config.runtime.reconciliationIntervalMs * 2;
    const concentrationPercent =
      Number(equity) > 0
        ? (Math.max(
            0,
            ...portfolioPositions.map((position) => position.marketValue.abs().toNumber()),
          ) /
            Number(equity)) *
          100
        : 0;
    const dailyRealizedPnl = dailyDispositions.reduce(
      (sum, disposition) => sum + disposition.realizedPnl.toNumber(),
      0,
    );
    const reconciliationFor = (symbol: string): 'MATCHED' | 'REVIEW' | 'MISMATCH' => {
      if (!reconciliationFresh) return 'REVIEW';
      const findings = latestReconciliation.discrepancies.filter(
        (item) => item.entityId === symbol || item.detail.includes(symbol),
      );
      if (findings.some((item) => item.classification === 'BLOCKING')) return 'MISMATCH';
      return findings.length > 0 ? 'REVIEW' : 'MATCHED';
    };

    return {
      generatedAt: now.toISOString(),
      mode: dependencies.config.trading.mode,
      systemState: operational.state,
      tradingEnabled: safety?.tradingEnabled ?? false,
      entriesEnabled: safety?.entriesEnabled ?? false,
      onlyClose: safety?.mode === 'ONLY_CLOSE',
      killSwitch: safety?.mode === 'KILL_SWITCH' || safety?.mode === 'EMERGENCY_STOP',
      freshness: {
        ...(portfolio === null
          ? {}
          : {
              accountAsOf: portfolio.createdAt.toISOString(),
              positionsAsOf: portfolio.createdAt.toISOString(),
            }),
        ...(marketDataStates.length === 0
          ? {}
          : {
              marketDataAsOf: marketDataStates
                .map((state) => state.lastValidTimestamp)
                .filter((value): value is Date => value !== null)
                .sort((left, right) => right.getTime() - left.getTime())[0]
                ?.toISOString(),
            }),
        ...(latestReconciliation === undefined
          ? {}
          : {
              reconciliationAsOf: (
                latestReconciliation.finishedAt ?? latestReconciliation.startedAt
              ).toISOString(),
            }),
      },
      account: {
        status: portfolio?.accountStatus ?? 'UNAVAILABLE',
        equity,
        cash,
        buyingPower,
        dailyPnl: dailyRealizedPnl.toFixed(2),
        drawdownPercent: equityPoint?.drawdownPercent.toString() ?? '0',
        marketClock: marketClock === null ? 'UNKNOWN' : marketClock.session,
        nextMarketEvent:
          marketClock === null
            ? 'UNKNOWN'
            : `${marketClock.isOpen ? 'Cierre' : 'Apertura'}: ${(marketClock.isOpen
                ? marketClock.nextClose
                : marketClock.nextOpen
              ).toISOString()}`,
      },
      services: [
        { name: 'application', state: 'UP', detail: 'API operativa' },
        { name: 'database', state: 'UP', detail: 'PostgreSQL conectado' },
        {
          name: 'alpaca',
          state: latestBrokerRequest === null ? 'UNKNOWN' : brokerFresh ? 'UP' : 'DOWN',
          detail: brokerFresh ? latestBrokerRequest.outcome : 'Sin contacto reciente',
          ...(latestBrokerRequest === null
            ? {}
            : {
                latencyMs: latestBrokerRequest.latencyMs,
                lastSuccessAt: latestBrokerRequest.occurredAt.toISOString(),
              }),
        },
        {
          name: 'market-data',
          state:
            marketDataStates.length === 0
              ? 'UNKNOWN'
              : unhealthyMarketData.length === 0
                ? 'UP'
                : 'DOWN',
          detail:
            marketDataStates.length === 0
              ? 'Sin símbolos sincronizados'
              : `${unhealthyMarketData.length}/${marketDataStates.length} no saludables`,
        },
        {
          name: 'scheduler',
          state: schedulerHealth,
          detail: schedulerState?.state ?? 'Sin estado',
        },
        {
          name: 'reconciliation',
          state:
            latestReconciliation === undefined
              ? 'UNKNOWN'
              : reconciliationFresh && ['MATCHED', 'CORRECTED'].includes(latestReconciliation.state)
                ? 'UP'
                : 'DOWN',
          detail: latestReconciliation?.state ?? 'Sin evidencia de reconciliación',
          ...(latestReconciliation === undefined
            ? {}
            : {
                lastSuccessAt: (
                  latestReconciliation.finishedAt ?? latestReconciliation.startedAt
                ).toISOString(),
              }),
        },
        {
          name: 'operational-safety',
          state:
            operational.state === 'READY'
              ? 'UP'
              : operational.state === 'DEGRADED'
                ? 'DEGRADED'
                : 'DOWN',
          detail: operational.reasonCode,
        },
      ],
      exposurePercent: exposurePercent.toFixed(2),
      positions: portfolioPositions.map((position) => {
        const managed = positions.find((item) => item.symbol === position.symbol);
        return {
          id: managed?.id ?? position.id,
          symbol: position.symbol,
          quantity: position.quantity.toString(),
          averageEntryPrice: position.averageEntryPrice.toString(),
          currentPrice: position.marketPrice.toString(),
          marketValue: position.marketValue.toString(),
          unrealizedPnl: position.unrealizedPnl.toString(),
          realizedPnl: position.realizedPnl.toString(),
          exposurePercent:
            Number(equity) > 0 ? position.marketValue.abs().div(equity).mul(100).toFixed(2) : '0',
          strategy: managed?.strategyId ?? position.strategyId ?? 'UNMANAGED',
          strategyVersion: managed?.strategyVersion ?? position.strategyVersion ?? 'UNKNOWN',
          ...(managed?.stopLossPrice === null || managed?.stopLossPrice === undefined
            ? {}
            : { stopPrice: managed.stopLossPrice.toString() }),
          ...(managed?.takeProfitPrice === null || managed?.takeProfitPrice === undefined
            ? {}
            : { targetPrice: managed.takeProfitPrice.toString() }),
          reconciliation: reconciliationFor(position.symbol),
        };
      }),
      orders: orders.map((order) => ({
        id: order.id,
        clientOrderId: order.clientOrderId,
        ...(order.brokerOrderId === null ? {} : { brokerOrderId: order.brokerOrderId }),
        symbol: order.symbol,
        side: order.side,
        type: `${order.orderClass}/${order.orderType}`,
        state: order.state,
        quantity: order.requestedQuantity.toString(),
        filledQuantity: order.filledQuantity.toString(),
        ...(order.averageFillPrice === null
          ? {}
          : { averageFillPrice: order.averageFillPrice.toString() }),
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        timeline: order.transitions.map((transition) => ({
          id: transition.id,
          type: `${transition.fromState} → ${transition.toState}`,
          detail: transition.reason,
          occurredAt: transition.occurredAt.toISOString(),
        })),
      })),
      trades: fills.map((fill) => {
        const realized = dailyDispositions
          .filter((item) => item.saleFillId === fill.id)
          .reduce((sum, item) => sum + item.realizedPnl.toNumber(), 0);
        const notional = fill.quantity.mul(fill.price).toNumber();
        return {
          id: fill.id,
          symbol: fill.symbol,
          strategy: fill.order.intent.strategyId,
          strategyVersion: fill.order.intent.strategyVersion,
          state: `FILLED_${fill.side.toUpperCase()}`,
          entryPrice: fill.price.toString(),
          quantity: fill.quantity.toString(),
          pnl: realized.toFixed(2),
          pnlPercent: notional > 0 ? ((realized / notional) * 100).toFixed(2) : '0',
          risk: 'Fill confirmado por broker y ledger local',
          duration: fill.occurredAt.toISOString(),
          entryReason: `Actividad FILL ${fill.side}`,
          correlationId: fill.order.intent.correlationId,
          timeline: [],
        };
      }),
      alerts: alerts.map((alert) => ({
        id: alert.id,
        severity: alert.severity,
        state: alert.state,
        title: alert.title,
        component: alert.component,
        occurredAt: alert.lastOccurredAt.toISOString(),
      })),
      watchlist: watchlist.map((item) => ({
        symbol: item.asset.symbol,
        active: item.active,
        tradable: item.asset.tradable,
        ...(item.asset.blocks[0]?.releasedAt === null
          ? { blockedReason: item.asset.blocks[0].reason }
          : {}),
      })),
      scanner: {
        state: scans[0]?.status ?? 'IDLE',
        ...(asIso(scans[0]?.finishedAt) === undefined
          ? {}
          : { lastExecutionAt: asIso(scans[0]?.finishedAt) }),
        history: scans.map((scan) => ({
          id: scan.id,
          status: scan.status,
          trigger: scan.trigger,
          startedAt: scan.startedAt.toISOString(),
          ...(scan.durationMs === null ? {} : { durationMs: scan.durationMs }),
          candidates: scan.results.filter((result) => result.accepted).length,
          rejections: scan.results.filter((result) => !result.accepted).length,
          errors: scan.symbolsFailed,
        })),
        rejections: (scans[0]?.results ?? [])
          .filter((result) => !result.accepted)
          .map((result) => ({
            id: result.id,
            type: result.rejectionCode ?? 'REJECTED',
            detail: result.rejectionReason ?? result.symbol,
            occurredAt: result.createdAt.toISOString(),
          })),
      },
      risk: {
        configurationVersion: riskConfiguration?.version ?? 'NOT_CONFIGURED',
        configuration: riskJson ?? {},
        usedPercent: exposurePercent.toFixed(2),
        availablePercent: Math.max(0, Number(maximumExposure) - exposurePercent).toFixed(2),
        dailyLossPercent:
          equityPoint?.realizedPnl.isNegative() && Number(equity) > 0
            ? equityPoint.realizedPnl.abs().div(equity).mul(100).toFixed(2)
            : '0',
        dailyLossLimitPercent: jsonField(riskJson, 'dailyLossLimitPercent', '2'),
        drawdownPercent: equityPoint?.drawdownPercent.toString() ?? '0',
        maximumDrawdownPercent: jsonField(riskJson, 'maximumDrawdownPercent', '8'),
        exposurePercent: exposurePercent.toFixed(2),
        maximumExposurePercent: maximumExposure,
        concentrationPercent: concentrationPercent.toFixed(2),
        positionCount: portfolioPositions.length,
        maximumPositions: Number(jsonField(riskJson, 'maximumPositions', '6')),
        dailyTradeCount: fills.filter((fill) => fill.occurredAt >= startOfCurrentMarketDay())
          .length,
        maximumDailyTrades: Number(jsonField(riskJson, 'maximumDailyTrades', '10')),
        recentRejections: riskDecisions.map((decision) => ({
          id: decision.id,
          type: 'RISK_REJECTED',
          detail: Array.isArray(decision.reasonCodes)
            ? decision.reasonCodes.map(String).join(', ')
            : 'Risk gate rejected',
          occurredAt: decision.evaluatedAt.toISOString(),
        })),
      },
      safety: {
        version: safety?.version ?? 0,
        activeBlocks: activeSymbolBlocks.map((block) => ({
          id: block.id,
          type: 'SYMBOL_BLOCK',
          detail: `${block.asset.symbol}: ${block.reason} (${block.source})`,
          occurredAt: block.blockedAt.toISOString(),
        })),
        circuitBreakers: circuitBreakers.map((breaker) => ({
          id: breaker.key,
          type: `CIRCUIT_${breaker.state}`,
          detail: `${breaker.scope}${breaker.scopeId ? `:${breaker.scopeId}` : ''}: ${breaker.reason ?? 'sin detalle'}`,
          occurredAt: (breaker.openedAt ?? breaker.updatedAt).toISOString(),
        })),
        history: safetyAudit.map((event) => ({
          id: event.id,
          type: event.action,
          detail: `${event.actor}: ${event.reason}`,
          occurredAt: event.occurredAt.toISOString(),
        })),
      },
      scheduler: {
        state: schedulerState?.state ?? 'STOPPED',
        intervalMs:
          schedulerConfiguration?.intervalMs ?? dependencies.config.runtime.schedulerIntervalMs,
        ...(asIso(schedulerState?.nextExecutionAt) === undefined
          ? {}
          : { nextExecutionAt: asIso(schedulerState?.nextExecutionAt) }),
        ...(asIso(schedulerState?.lastExecutionAt) === undefined
          ? {}
          : { lastExecutionAt: asIso(schedulerState?.lastExecutionAt) }),
        history: schedulerExecutions.map((execution) => ({
          id: execution.id,
          status: execution.result,
          trigger: execution.trigger,
          startedAt: execution.startedAt.toISOString(),
          durationMs: execution.durationMs,
          candidates: execution.candidateCount,
          rejections: execution.rejectionCount,
          errors: execution.errorCount,
        })),
      },
      backtests: backtests.map((backtest) => ({
        id: backtest.id,
        strategy: backtest.strategyId,
        strategyVersion: backtest.strategyVersion,
        symbol: backtest.symbol,
        range: `${jsonField(backtest.inputConfiguration, 'from', backtest.startedAt.toISOString()).slice(0, 10)} → ${jsonField(backtest.inputConfiguration, 'to', backtest.finishedAt.toISOString()).slice(0, 10)}`,
        netProfit: jsonField(backtest.metrics, 'netProfit', '0'),
        winRate: jsonField(backtest.metrics, 'winRate', '0'),
        profitFactor: jsonField(backtest.metrics, 'profitFactor', '—'),
        expectancy: jsonField(backtest.metrics, 'expectancy', '0'),
        sharpe: jsonField(backtest.metrics, 'sharpeRatio', '—'),
        maximumDrawdown: jsonField(backtest.metrics, 'maximumDrawdownPercent', '0'),
        equityCurve: backtest.equityCurve.map((point) => ({
          timestamp: point.timestamp.toISOString(),
          equity: point.equity.toNumber(),
        })),
      })),
      backtestJobs: backtestJobs.map((job) => ({
        id: job.id,
        status: job.status,
        progress: job.progress,
        ...(job.error === null ? {} : { error: job.error }),
        ...(job.runId === null ? {} : { runId: job.runId }),
        createdAt: job.createdAt.toISOString(),
      })),
      logs: auditEvents.map((event) => ({
        id: event.id,
        level:
          event.severity === 'CRITICAL' ? 'ERROR' : event.severity === 'WARNING' ? 'WARN' : 'INFO',
        component: event.resourceType,
        message: `${event.action}: ${event.outcome}`,
        correlationId: event.correlationId,
        occurredAt: event.occurredAt.toISOString(),
      })),
      reconciliationHistory: reconciliations.flatMap((reconciliation) =>
        reconciliation.discrepancies.map((discrepancy) => ({
          id: discrepancy.id,
          type: discrepancy.code,
          detail: discrepancy.detail,
          occurredAt: discrepancy.createdAt.toISOString(),
        })),
      ),
    };
  });

  server.post(
    '/api/operations/actions/:action',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const session = await dependencies.authService.authenticateWithCsrf(
        request.cookies[sessionCookie],
        csrfHeader(request),
      );
      const action = z
        .string()
        .min(1)
        .max(64)
        .parse((request.params as { action?: unknown }).action);
      const parsed = actionSchema.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new InputValidationError('OPERATION_INPUT_INVALID', 'Invalid operation');
      if (actionRequiresStrongConfirmation(action) && parsed.data.confirmation !== 'CONFIRMAR')
        throw new InputValidationError(
          'STRONG_CONFIRMATION_REQUIRED',
          'Strong confirmation is required',
        );
      if (actionRequiresStrongConfirmation(action)) {
        if (!parsed.data.reauthenticationPassword)
          throw new InputValidationError(
            'REAUTHENTICATION_REQUIRED',
            'Operator password is required for this critical action',
          );
        await dependencies.authService.reauthenticate(
          session.operatorId,
          parsed.data.reauthenticationPassword,
          { correlationId: request.id },
        );
        if (
          dependencies.config.trading.mode === 'LIVE' &&
          (!dependencies.config.security.operatorTotpSecret ||
            !parsed.data.totpCode ||
            !verifyTotp(parsed.data.totpCode, dependencies.config.security.operatorTotpSecret))
        )
          throw new InputValidationError(
            'MFA_REQUIRED',
            'A current six-digit TOTP code is required for critical LIVE operations',
          );
      }
      const now = new Date();
      const audit = (outcome: string, metadata: object = {}) =>
        dependencies.database.auditEvent.create({
          data: {
            operatorId: session.operatorId,
            severity: action === 'kill-switch' ? 'CRITICAL' : 'INFO',
            action: `OPERATIONS_${action.toUpperCase().replaceAll('-', '_')}`,
            resourceType: 'OPERATIONS',
            correlationId: request.id,
            outcome,
            metadata,
            occurredAt: now,
          },
        });
      const context = { actor: session.operatorId, correlationId: request.id };
      let result: unknown;
      switch (action) {
        case 'kill-switch':
          await dependencies.operationsRuntime.killSwitch(context);
          await audit('SUCCEEDED', { mode: 'KILL_SWITCH' });
          break;
        case 'entries-disable':
          await dependencies.operationsRuntime.disableEntries(context);
          await audit('SUCCEEDED', { mode: 'ONLY_CLOSE' });
          break;
        case 'scheduler-start':
          await dependencies.operationsRuntime.schedulerStart(context);
          await audit('SUCCEEDED', { state: 'RUNNING' });
          break;
        case 'scheduler-resume':
          await dependencies.operationsRuntime.schedulerResume(context);
          await audit('SUCCEEDED', { state: 'RUNNING' });
          break;
        case 'scheduler-pause':
          await dependencies.operationsRuntime.schedulerPause(context);
          await audit('SUCCEEDED', { state: 'PAUSED' });
          break;
        case 'scheduler-stop':
          await dependencies.operationsRuntime.schedulerStop(context);
          await audit('SUCCEEDED', { state: 'STOPPED' });
          break;
        case 'scanner-run':
          result = await dependencies.operationsRuntime.scannerRun(context);
          await audit('SUCCEEDED');
          break;
        case 'backtest-run':
          if (!parsed.data.symbol || !parsed.data.strategy)
            throw new InputValidationError(
              'BACKTEST_INPUT_REQUIRED',
              'Symbol and strategy are required',
            );
          result = await dependencies.operationsRuntime.startBacktest(
            {
              symbol: parsed.data.symbol,
              strategyId: parsed.data.strategy,
              ...(parsed.data.from ? { from: parsed.data.from } : {}),
              ...(parsed.data.to ? { to: parsed.data.to } : {}),
              ...(parsed.data.initialCapital ? { initialCapital: parsed.data.initialCapital } : {}),
            },
            context,
          );
          await audit('SUCCEEDED', { symbol: parsed.data.symbol, strategy: parsed.data.strategy });
          break;
        case 'backtest-cancel':
          if (!parsed.data.backtestJobId)
            throw new InputValidationError(
              'BACKTEST_JOB_ID_REQUIRED',
              'Backtest job ID is required',
            );
          result = await dependencies.operationsRuntime.cancelBacktest(
            parsed.data.backtestJobId,
            context,
          );
          await audit('SUCCEEDED', { backtestJobId: parsed.data.backtestJobId });
          break;
        case 'position-close':
          if (!parsed.data.positionId)
            throw new InputValidationError('POSITION_ID_REQUIRED', 'Position ID is required');
          result = await dependencies.operationsRuntime.closePosition(
            parsed.data.positionId,
            context,
          );
          await audit('SUCCEEDED', { positionId: parsed.data.positionId });
          break;
        case 'order-cancel':
          if (!parsed.data.orderId)
            throw new InputValidationError('ORDER_ID_REQUIRED', 'Order ID is required');
          result = await dependencies.operationsRuntime.cancelOrder(parsed.data.orderId, context);
          await audit('SUCCEEDED', { orderId: parsed.data.orderId });
          break;
        case 'risk-edit':
          if (parsed.data.riskConfiguration === undefined)
            throw new InputValidationError(
              'RISK_CONFIGURATION_REQUIRED',
              'A complete new risk configuration is required',
            );
          result = await dependencies.operationsRuntime.editRisk(
            parsed.data.riskConfiguration,
            context,
          );
          await audit('SUCCEEDED');
          break;
        case 'safety-recover':
          result = await dependencies.operationsRuntime.recoverSafety(
            {
              ...(parsed.data.blockId ? { blockId: parsed.data.blockId } : {}),
              ...(parsed.data.checks ? { checks: parsed.data.checks } : {}),
            },
            context,
          );
          await audit('SUCCEEDED');
          break;
        case 'alert-ack':
          if (!parsed.data.alertId)
            throw new InputValidationError('ALERT_ID_REQUIRED', 'Alert ID is required');
          result = await dependencies.operationsRuntime.acknowledgeAlert(
            parsed.data.alertId,
            context,
          );
          await audit('SUCCEEDED', { alertId: parsed.data.alertId });
          break;
        case 'validation-attest': {
          const { validationKind, artifactSha256, evidenceDetail, evidenceExecutedAt } =
            parsed.data;
          if (
            !validationKind ||
            !artifactSha256 ||
            !evidenceDetail ||
            !evidenceExecutedAt ||
            !parsed.data.sourceEnvironment
          )
            throw new InputValidationError(
              'VALIDATION_EVIDENCE_REQUIRED',
              'Complete validation evidence is required',
            );
          const executedAt = new Date(evidenceExecutedAt);
          if (
            executedAt.getTime() > now.getTime() + 60_000 ||
            executedAt.getTime() < now.getTime() - 30 * 86_400_000
          )
            throw new InputValidationError(
              'VALIDATION_EVIDENCE_STALE',
              'Validation evidence must be no more than 30 days old and cannot be in the future',
            );
          result = await dependencies.database.auditEvent.create({
            data: {
              operatorId: session.operatorId,
              severity: 'CRITICAL',
              action: `VALIDATION_${validationKind}`,
              resourceType: 'VALIDATION_EVIDENCE',
              resourceId: artifactSha256,
              correlationId: request.id,
              outcome: 'SUCCEEDED',
              metadata: {
                artifactSha256: artifactSha256.toLowerCase(),
                detail: evidenceDetail,
                executedAt: executedAt.toISOString(),
                sourceEnvironment: parsed.data.sourceEnvironment,
                attestedBy: session.operatorId,
              },
              occurredAt: now,
            },
          });
          break;
        }
        case 'watchlist-add': {
          if (parsed.data.symbol === undefined)
            throw new InputValidationError('SYMBOL_REQUIRED', 'Symbol is required');
          result = await dependencies.operationsRuntime.updateWatchlist(
            parsed.data.symbol,
            true,
            context,
          );
          break;
        }
        case 'watchlist-toggle': {
          if (parsed.data.symbol === undefined || parsed.data.active === undefined)
            throw new InputValidationError(
              'WATCHLIST_INPUT_REQUIRED',
              'Symbol and active state are required',
            );
          result = await dependencies.operationsRuntime.updateWatchlist(
            parsed.data.symbol,
            parsed.data.active,
            context,
          );
          break;
        }
        default:
          await audit('REJECTED', { reason: 'RUNTIME_NOT_AVAILABLE' });
          throw new InputValidationError(
            'OPERATION_NOT_SUPPORTED',
            'Operation is not supported by this release',
          );
      }
      return reply.code(200).send({
        ok: true,
        action,
        persistedAt: now.toISOString(),
        ...(result === undefined ? {} : { result }),
      });
    },
  );
}

function startOfCurrentMarketDay(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return marketLocalToUtc(`${part('year')}-${part('month')}-${part('day')}`, '00:00');
}
