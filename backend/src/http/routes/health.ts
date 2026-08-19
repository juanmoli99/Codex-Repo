import type { FastifyInstance } from 'fastify';

import type { HealthComponent, HealthReport, HealthState } from '@aegis/shared';

import type { AppDependencies } from '../types.js';

export function registerHealthRoutes(server: FastifyInstance, dependencies: AppDependencies): void {
  server.get('/health/live', () => ({
    status: 'UP',
    timestamp: new Date().toISOString(),
  }));

  server.get('/health/ready', async (_request, reply) => {
    const components: HealthComponent[] = [];
    const now = new Date();
    const databaseStarted = performance.now();
    let databaseAvailable = false;
    try {
      await dependencies.database.$queryRaw`SELECT 1`;
      databaseAvailable = true;
      components.push({
        name: 'database',
        state: 'UP',
        latencyMs: Math.round(performance.now() - databaseStarted),
        checkedAt: new Date().toISOString(),
      });
    } catch {
      components.push({
        name: 'database',
        state: 'DOWN',
        checkedAt: new Date().toISOString(),
        message: 'Database check failed',
      });
    }

    if (!databaseAvailable) {
      const snapshot = dependencies.operationalState.current();
      components.push({
        name: 'operational-safety',
        state: 'DOWN',
        checkedAt: now.toISOString(),
        message: snapshot.reasonCode,
      });
      const report: HealthReport = {
        status: 'DOWN',
        systemState: snapshot.state,
        mode: dependencies.config.trading.mode,
        timestamp: now.toISOString(),
        components,
      };
      return reply.code(503).send(report);
    }

    const [broker, marketData, reconciliation, unknownOrders, clock, worker] = await Promise.all([
      dependencies.database.brokerRequestRecord.findFirst({
        where: { service: 'trading', outcome: 'SUCCEEDED' },
        orderBy: { occurredAt: 'desc' },
      }),
      dependencies.database.marketDataStateRecord.findMany(),
      dependencies.database.reconciliationRecord.findFirst({ orderBy: { startedAt: 'desc' } }),
      dependencies.database.orderRecord.count({ where: { state: 'UNKNOWN' } }),
      dependencies.database.marketClockRecord.findUnique({ where: { id: 'singleton' } }),
      dependencies.database.workerHeartbeatRecord.findFirst({
        where: { kind: 'TRADING_SCHEDULER' },
        orderBy: { heartbeatAt: 'desc' },
      }),
    ]);
    const age = (value: Date): number => now.getTime() - value.getTime();
    components.push({
      name: 'alpaca',
      state: broker === null ? 'UNKNOWN' : age(broker.occurredAt) <= 60_000 ? 'UP' : 'DOWN',
      checkedAt: now.toISOString(),
      message:
        broker === null
          ? 'No successful broker request has been observed'
          : `Last successful broker request was ${age(broker.occurredAt)}ms ago`,
    });
    const unhealthyMarketData = marketData.filter(
      (item) =>
        item.health !== 'HEALTHY' ||
        item.lastBarAt === null ||
        item.lastQuoteAt === null ||
        item.lastTradeAt === null ||
        age(item.lastBarAt) > dependencies.config.runtime.marketDataMaxAgeMs ||
        age(item.lastQuoteAt) > dependencies.config.runtime.marketDataMaxAgeMs ||
        age(item.lastTradeAt) > dependencies.config.runtime.marketDataMaxAgeMs,
    );
    components.push({
      name: 'market-data',
      state: marketData.length === 0 ? 'UNKNOWN' : unhealthyMarketData.length === 0 ? 'UP' : 'DOWN',
      checkedAt: now.toISOString(),
      message:
        marketData.length === 0
          ? 'No market-data evidence exists'
          : `${unhealthyMarketData.length}/${marketData.length} symbols are unhealthy or stale`,
    });
    const reconciliationFresh =
      reconciliation?.finishedAt !== null &&
      reconciliation?.finishedAt !== undefined &&
      age(reconciliation.finishedAt) <= dependencies.config.runtime.reconciliationIntervalMs * 2;
    components.push({
      name: 'reconciliation',
      state:
        reconciliation === null
          ? 'UNKNOWN'
          : reconciliationFresh && ['MATCHED', 'CORRECTED'].includes(reconciliation.state)
            ? 'UP'
            : 'DOWN',
      checkedAt: now.toISOString(),
      message: reconciliation?.state ?? 'No reconciliation evidence exists',
    });
    components.push({
      name: 'unknown-orders',
      state: unknownOrders === 0 ? 'UP' : 'DOWN',
      checkedAt: now.toISOString(),
      message: `${unknownOrders} unresolved UNKNOWN orders`,
    });
    components.push({
      name: 'market-clock',
      state: clock === null ? 'UNKNOWN' : age(clock.observedAt) <= 120_000 ? 'UP' : 'DOWN',
      checkedAt: now.toISOString(),
      message: clock === null ? 'No broker clock evidence exists' : clock.session,
    });
    components.push({
      name: 'scheduler-worker',
      state:
        worker === null
          ? 'UNKNOWN'
          : age(worker.heartbeatAt) <= dependencies.config.runtime.workerDeadAfterMs
            ? 'UP'
            : 'DOWN',
      checkedAt: now.toISOString(),
      message: worker === null ? 'No worker heartbeat exists' : worker.status,
    });

    const snapshot = dependencies.operationalState.current();
    components.push({
      name: 'operational-safety',
      state:
        snapshot.state === 'READY' ? 'UP' : snapshot.state === 'DEGRADED' ? 'DEGRADED' : 'DOWN',
      checkedAt: new Date().toISOString(),
      message: snapshot.reasonCode,
    });
    const status: HealthState = components.some((component) => component.state === 'DOWN')
      ? 'DOWN'
      : components.some((component) => component.state === 'UNKNOWN')
        ? 'UNKNOWN'
        : components.some((component) => component.state === 'DEGRADED')
          ? 'DEGRADED'
          : 'UP';
    const report: HealthReport = {
      status,
      systemState: snapshot.state,
      mode: dependencies.config.trading.mode,
      timestamp: new Date().toISOString(),
      components,
    };
    return reply.code(status === 'UP' ? 200 : 503).send(report);
  });

  server.get('/metrics', async (_request, reply) => {
    const now = new Date();
    try {
      const [
        requests,
        rateBudgets,
        breakers,
        marketData,
        clock,
        worker,
        reconciliation,
        unknownOrders,
        openOrders,
        partialOrders,
        rejectedOrders,
        portfolio,
        equity,
        dailyPnl,
      ] = await Promise.all([
        dependencies.database.brokerRequestRecord.aggregate({
          _avg: { latencyMs: true },
          _count: { id: true },
        }),
        dependencies.database.rateLimitBudgetRecord.findMany(),
        dependencies.database.circuitBreakerRecord.findMany(),
        dependencies.database.marketDataStateRecord.findMany({ take: 1_000 }),
        dependencies.database.marketClockRecord.findUnique({ where: { id: 'singleton' } }),
        dependencies.database.workerHeartbeatRecord.findFirst({
          where: { kind: 'TRADING_SCHEDULER' },
          orderBy: { heartbeatAt: 'desc' },
        }),
        dependencies.database.reconciliationRecord.findFirst({
          orderBy: { startedAt: 'desc' },
          include: { discrepancies: true },
        }),
        dependencies.database.orderRecord.count({ where: { state: 'UNKNOWN' } }),
        dependencies.database.orderRecord.count({
          where: {
            state: {
              in: ['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_PENDING'],
            },
          },
        }),
        dependencies.database.orderRecord.count({ where: { state: 'PARTIALLY_FILLED' } }),
        dependencies.database.orderRecord.count({ where: { state: 'REJECTED' } }),
        dependencies.database.portfolioSnapshot.findFirst({
          orderBy: { createdAt: 'desc' },
          include: { positions: true },
        }),
        dependencies.database.equityCurvePointRecord.findFirst({
          orderBy: { capturedAt: 'desc' },
        }),
        dependencies.database.lotDispositionRecord.aggregate({
          where: { soldAt: { gte: startOfMarketDay(now) } },
          _sum: { realizedPnl: true },
        }),
      ]);
      const lines = [
        '# TYPE aegis_alpaca_latency_ms gauge',
        `aegis_alpaca_latency_ms ${requests._avg.latencyMs ?? 0}`,
        `aegis_alpaca_requests_total ${requests._count.id}`,
        `aegis_unknown_orders ${unknownOrders}`,
        `aegis_open_orders ${openOrders}`,
        `aegis_partial_orders ${partialOrders}`,
        `aegis_rejected_orders ${rejectedOrders}`,
        `aegis_reconciliation_age_seconds ${reconciliation?.finishedAt ? Math.max(0, (now.getTime() - reconciliation.finishedAt.getTime()) / 1_000) : -1}`,
        `aegis_reconciliation_discrepancies ${reconciliation?.discrepancies.filter((item) => item.resolvedAt === null).length ?? 0}`,
        `aegis_clock_skew_ms ${clock ? Math.abs(now.getTime() - clock.brokerTime.getTime()) : -1}`,
        `aegis_worker_heartbeat_age_seconds ${worker ? Math.max(0, (now.getTime() - worker.heartbeatAt.getTime()) / 1_000) : -1}`,
        `aegis_worker_leader ${worker?.leader ? 1 : 0}`,
        `aegis_equity ${portfolio?.equity.toFixed() ?? 0}`,
        `aegis_cash ${portfolio?.cash.toFixed() ?? 0}`,
        `aegis_buying_power ${portfolio?.buyingPower.toFixed() ?? 0}`,
        `aegis_exposure ${portfolio?.positions.reduce((sum, position) => sum + position.marketValue.abs().toNumber(), 0) ?? 0}`,
        `aegis_drawdown_percent ${equity?.drawdownPercent.toFixed() ?? 0}`,
        `aegis_daily_realized_pnl ${dailyPnl._sum.realizedPnl?.toFixed() ?? 0}`,
        ...rateBudgets.map(
          (budget) =>
            `aegis_rate_budget_tokens{key="${metricLabel(budget.id)}"} ${budget.tokens.toFixed()}`,
        ),
        ...breakers.map(
          (breaker) =>
            `aegis_circuit_breaker{scope="${metricLabel(breaker.scope)}",scope_id="${metricLabel(breaker.scopeId ?? '')}",state="${metricLabel(breaker.state)}"} 1`,
        ),
        ...marketData.map((state) => {
          const timestamps = [state.lastBarAt, state.lastQuoteAt, state.lastTradeAt].filter(
            (value): value is Date => value !== null,
          );
          const oldest = timestamps.length
            ? Math.max(...timestamps.map((value) => now.getTime() - value.getTime())) / 1_000
            : -1;
          return `aegis_market_data_age_seconds{symbol="${metricLabel(state.symbol)}",health="${metricLabel(state.health)}"} ${oldest}`;
        }),
      ];
      return await reply
        .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(`${lines.join('\n')}\n`);
    } catch {
      return reply.code(503).send('aegis_metrics_collection_up 0\n');
    }
  });
}

function metricLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function startOfMarketDay(instant: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const noonUtc = new Date(`${values.year}-${values.month}-${values.day}T12:00:00.000Z`);
  const timezoneName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  })
    .formatToParts(noonUtc)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = timezoneName?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) throw new Error('Cannot resolve New York UTC offset');
  const offset = `${match[1]}${match[2]}:${match[3]}`;
  return new Date(`${values.year}-${values.month}-${values.day}T00:00:00${offset}`);
}
