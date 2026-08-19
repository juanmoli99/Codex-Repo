import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sessionCookieName } from '../session-cookie.js';
import type { AppDependencies } from '../types.js';

const pageSchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

async function authenticateRead(
  request: FastifyRequest,
  dependencies: AppDependencies,
  cookieName: string,
): Promise<void> {
  await dependencies.authService.authenticate(request.cookies[cookieName]);
}

function page<T extends { id: string }>(records: readonly T[], limit: number) {
  const hasMore = records.length > limit;
  const items = records.slice(0, limit);
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.id : undefined,
  };
}

export function registerHistoryRoutes(
  server: FastifyInstance,
  dependencies: AppDependencies,
): void {
  const cookieName = sessionCookieName(dependencies.config);

  server.get('/api/orders', async (request) => {
    await authenticateRead(request, dependencies, cookieName);
    const query = pageSchema.parse(request.query);
    const records = await dependencies.database.orderRecord.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        brokerOrderId: true,
        clientOrderId: true,
        symbol: true,
        side: true,
        type: true,
        state: true,
        requestedQuantity: true,
        filledQuantity: true,
        averageFillPrice: true,
        reconciliationDue: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return page(
      records.map((record) => ({
        ...record,
        requestedQuantity: record.requestedQuantity.toFixed(),
        filledQuantity: record.filledQuantity.toFixed(),
        averageFillPrice: record.averageFillPrice?.toFixed(),
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      })),
      query.limit,
    );
  });

  server.get('/api/logs', async (request) => {
    await authenticateRead(request, dependencies, cookieName);
    const query = pageSchema.parse(request.query);
    const records = await dependencies.database.auditEvent.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        severity: true,
        action: true,
        resourceType: true,
        resourceId: true,
        correlationId: true,
        outcome: true,
        metadata: true,
        occurredAt: true,
      },
    });
    return page(
      records.map((record) => ({ ...record, occurredAt: record.occurredAt.toISOString() })),
      query.limit,
    );
  });

  server.get('/api/backtests', async (request) => {
    await authenticateRead(request, dependencies, cookieName);
    const query = pageSchema.parse(request.query);
    const records = await dependencies.database.backtestRunRecord.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        configurationId: true,
        symbol: true,
        strategyId: true,
        strategyVersion: true,
        configurationVersion: true,
        inputConfiguration: true,
        metrics: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
    });
    return page(
      records.map((record) => ({
        ...record,
        startedAt: record.startedAt.toISOString(),
        finishedAt: record.finishedAt.toISOString(),
        createdAt: record.createdAt.toISOString(),
      })),
      query.limit,
    );
  });

  server.get('/api/reconciliations', async (request) => {
    await authenticateRead(request, dependencies, cookieName);
    const query = pageSchema.parse(request.query);
    const records = await dependencies.database.reconciliationRecord.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        trigger: true,
        state: true,
        safeCorrectionsApplied: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        _count: { select: { discrepancies: true } },
      },
    });
    return page(
      records.map(({ _count, ...record }) => ({
        ...record,
        discrepancyCount: _count.discrepancies,
        startedAt: record.startedAt.toISOString(),
        finishedAt: record.finishedAt?.toISOString(),
        createdAt: record.createdAt.toISOString(),
      })),
      query.limit,
    );
  });
}
