import { Decimal } from 'decimal.js';

import { alpacaOrderSchema, type AlpacaOrderRequest } from '../alpaca/types.js';
import type { BrokerRequestObservation } from '../alpaca/http-client.js';
import type { ExecutionCoordinator } from '../concurrency/coordinator.js';
import type { DatabaseClient } from '../database/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OrderAggregate } from '../execution/order-state-machine.js';
import type { OrderTransition } from '../execution/order-state-machine.js';
import type {
  TradeExecutionRepository,
  TradeExecutionResult,
  TradeIntent,
  TradeIntentState,
} from '../execution/trade-executor.js';
import type {
  CircuitBreakerRepository,
  CircuitBreakerSnapshot,
} from '../safety/circuit-breakers.js';
import type {
  SafetyAuditEvent,
  SafetyBlock,
  SafetyRepository,
  SafetyState,
} from '../safety/service.js';

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class PrismaSafetyRepository implements SafetyRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async saveState(state: SafetyState): Promise<void> {
    await this.database.safetyStateRecord.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        version: state.version,
        tradingMode: state.tradingMode,
        mode: state.mode,
        tradingEnabled: state.tradingEnabled,
        entriesEnabled: state.entriesEnabled,
        exitsAllowed: state.exitsAllowed,
        ...(state.globalLockOwner ? { globalLockOwner: state.globalLockOwner } : {}),
        blocks: json(state.blocks),
        lastChangedAt: state.lastChangedAt,
      },
      update: {
        version: state.version,
        tradingMode: state.tradingMode,
        mode: state.mode,
        tradingEnabled: state.tradingEnabled,
        entriesEnabled: state.entriesEnabled,
        exitsAllowed: state.exitsAllowed,
        globalLockOwner: state.globalLockOwner ?? null,
        blocks: json(state.blocks),
        lastChangedAt: state.lastChangedAt,
      },
    });
  }

  public async appendAudit(event: SafetyAuditEvent): Promise<void> {
    await this.database.safetyAuditRecord.create({
      data: {
        id: event.id,
        action: event.action,
        actor: event.actor,
        reason: event.reason,
        before: json(event.before),
        after: json(event.after),
        occurredAt: event.occurredAt,
      },
    });
  }
}

export async function loadSafetyState(
  database: DatabaseClient,
  mode: SafetyState['tradingMode'],
): Promise<SafetyState | undefined> {
  const record = await database.safetyStateRecord.findUnique({ where: { id: 'singleton' } });
  if (!record) return undefined;
  const rawBlocks = Array.isArray(record.blocks) ? record.blocks : [];
  const blocks: SafetyBlock[] = rawBlocks.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const block = value as Record<string, unknown>;
    if (
      typeof block.id !== 'string' ||
      typeof block.scope !== 'string' ||
      typeof block.reason !== 'string' ||
      typeof block.detail !== 'string' ||
      typeof block.blockedAt !== 'string' ||
      typeof block.cooldownUntil !== 'string'
    )
      return [];
    return [
      {
        id: block.id,
        scope: block.scope as SafetyBlock['scope'],
        ...(typeof block.scopeId === 'string' ? { scopeId: block.scopeId } : {}),
        reason: block.reason as SafetyBlock['reason'],
        detail: block.detail,
        blockedAt: new Date(block.blockedAt),
        cooldownUntil: new Date(block.cooldownUntil),
        manualOverride: block.manualOverride === true,
      },
    ];
  });
  return {
    version: record.version,
    tradingMode: mode,
    mode: record.mode,
    tradingEnabled: record.tradingEnabled,
    entriesEnabled: record.entriesEnabled,
    exitsAllowed: record.exitsAllowed,
    ...(record.globalLockOwner ? { globalLockOwner: record.globalLockOwner } : {}),
    blocks,
    lastChangedAt: record.lastChangedAt,
  };
}

export class PrismaCircuitBreakerRepository implements CircuitBreakerRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async find(key: string): Promise<CircuitBreakerSnapshot | undefined> {
    const record = await this.database.circuitBreakerRecord.findUnique({ where: { key } });
    return record ? this.map(record) : undefined;
  }

  public async save(snapshot: CircuitBreakerSnapshot): Promise<void> {
    await this.database.circuitBreakerRecord.upsert({
      where: { key: snapshot.key },
      create: {
        key: snapshot.key,
        scope: snapshot.scope,
        ...(snapshot.scopeId ? { scopeId: snapshot.scopeId } : {}),
        state: snapshot.state,
        failureCount: snapshot.failureCount,
        threshold: snapshot.threshold,
        ...(snapshot.reason ? { reason: snapshot.reason } : {}),
        ...(snapshot.openedAt ? { openedAt: snapshot.openedAt } : {}),
        ...(snapshot.cooldownUntil ? { cooldownUntil: snapshot.cooldownUntil } : {}),
        ...(snapshot.lastFailureAt ? { lastFailureAt: snapshot.lastFailureAt } : {}),
        ...(snapshot.lastSuccessAt ? { lastSuccessAt: snapshot.lastSuccessAt } : {}),
        version: snapshot.version,
      },
      update: {
        state: snapshot.state,
        failureCount: snapshot.failureCount,
        threshold: snapshot.threshold,
        reason: snapshot.reason ?? null,
        openedAt: snapshot.openedAt ?? null,
        cooldownUntil: snapshot.cooldownUntil ?? null,
        lastFailureAt: snapshot.lastFailureAt ?? null,
        lastSuccessAt: snapshot.lastSuccessAt ?? null,
        version: snapshot.version,
      },
    });
  }

  public async listOpen(): Promise<readonly CircuitBreakerSnapshot[]> {
    const records = await this.database.circuitBreakerRecord.findMany({
      where: { state: { not: 'CLOSED' } },
      orderBy: { updatedAt: 'desc' },
    });
    return records.map((record) => this.map(record));
  }

  private map(
    record: Awaited<ReturnType<DatabaseClient['circuitBreakerRecord']['findFirstOrThrow']>>,
  ): CircuitBreakerSnapshot {
    return {
      key: record.key,
      scope: record.scope as CircuitBreakerSnapshot['scope'],
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      state: record.state as CircuitBreakerSnapshot['state'],
      failureCount: record.failureCount,
      threshold: record.threshold,
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.openedAt ? { openedAt: record.openedAt } : {}),
      ...(record.cooldownUntil ? { cooldownUntil: record.cooldownUntil } : {}),
      ...(record.lastFailureAt ? { lastFailureAt: record.lastFailureAt } : {}),
      ...(record.lastSuccessAt ? { lastSuccessAt: record.lastSuccessAt } : {}),
      version: record.version,
    };
  }
}

export class PrismaTradeExecutionRepository implements TradeExecutionRepository {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly coordinator: ExecutionCoordinator,
  ) {}

  public executeWithIntentLock<T>(intent: TradeIntent, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.exclusively(
      [`intent:${intent.deduplicationKey}`, `symbol:${intent.signal.symbol}`],
      120_000,
      operation,
    );
  }

  public async hasActiveProtection(symbol: string): Promise<boolean> {
    return (
      (await this.database.protectionGroupRecord.count({
        where: { symbol, state: { in: ['PENDING', 'ACTIVE', 'REPLACING'] } },
      })) > 0
    );
  }

  public async findByDeduplicationKey(key: string): Promise<TradeExecutionResult | undefined> {
    const intent = await this.database.tradeIntentRecord.findUnique({
      where: { deduplicationKey: key },
      include: {
        orders: {
          orderBy: { createdAt: 'asc' },
          include: { transitions: { orderBy: { sequence: 'asc' } }, fills: true },
        },
      },
    });
    if (!intent) return undefined;
    const record = intent.orders[0];
    if (!record)
      return {
        intentId: intent.id,
        intentState: intent.state,
        reasons: Array.isArray(intent.rejectionReasons) ? intent.rejectionReasons.map(String) : [],
        reconciliationRequired: intent.state === 'UNKNOWN',
      };
    const order = OrderAggregate.rehydrate({
      id: record.id,
      tradeIntentId: record.tradeIntentId,
      clientOrderId: record.clientOrderId,
      symbol: record.symbol,
      side: record.side as 'buy' | 'sell',
      requestedQuantity: record.requestedQuantity,
      state: record.state,
      transitions: record.transitions.map((transition) => ({
        sequence: transition.sequence,
        from: transition.fromState,
        to: transition.toState,
        reason: transition.reason,
        occurredAt: transition.occurredAt,
        ...(transition.brokerStatus ? { brokerStatus: transition.brokerStatus } : {}),
      })),
      fills: record.fills.map((fill) => ({
        id: fill.id,
        orderId: fill.orderId,
        tradeIntentId: fill.tradeIntentId,
        symbol: fill.symbol,
        side: fill.side as 'buy' | 'sell',
        quantity: new Decimal(fill.quantity),
        price: new Decimal(fill.price),
        occurredAt: fill.occurredAt,
        unexpected: fill.unexpected,
      })),
      ...(record.parentOrderId ? { parentOrderId: record.parentOrderId } : {}),
      ...(record.originalOrderId ? { originalOrderId: record.originalOrderId } : {}),
    });
    const broker = alpacaOrderSchema.safeParse(record.brokerResponse);
    return {
      intentId: intent.id,
      intentState: intent.state,
      order,
      ...(broker.success ? { brokerOrder: broker.data } : {}),
      reasons: Array.isArray(intent.rejectionReasons) ? intent.rejectionReasons.map(String) : [],
      reconciliationRequired: record.reconciliationDue,
    };
  }

  public async saveIntent(intent: TradeIntent, state: TradeIntentState): Promise<void> {
    await this.database.tradeIntentRecord.create({
      data: {
        id: intent.id,
        deduplicationKey: intent.deduplicationKey,
        signalId: intent.signal.id,
        symbol: intent.signal.symbol,
        strategyId: intent.signal.strategyId,
        strategyVersion: intent.signal.strategyVersion,
        state,
        correlationId: intent.correlationId,
        ...(intent.parentIntentId ? { parentIntentId: intent.parentIntentId } : {}),
        specification: json(intent.specification),
        immutableConfigurationSnapshot: json(intent.immutableConfigurationSnapshot),
        createdAt: intent.createdAt,
      },
    });
  }

  public async saveOrder(order: OrderAggregate, request: AlpacaOrderRequest): Promise<void> {
    await this.database.orderRecord.create({
      data: {
        id: order.id,
        tradeIntentId: order.tradeIntentId,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        orderType: request.type,
        orderClass: request.order_class ?? 'simple',
        timeInForce: request.time_in_force,
        state: 'CREATED',
        requestedQuantity: order.requestedQuantity,
        ...(request.limit_price ? { limitPrice: request.limit_price } : {}),
        ...(request.stop_price ? { stopPrice: request.stop_price } : {}),
        ...(order.parentOrderId ? { parentOrderId: order.parentOrderId } : {}),
        ...(order.originalOrderId ? { originalOrderId: order.originalOrderId } : {}),
      },
    });
  }

  public async appendTransition(orderId: string, transition: OrderTransition): Promise<void> {
    await this.database.$transaction([
      this.database.orderTransitionRecord.create({
        data: {
          orderId,
          sequence: transition.sequence,
          fromState: transition.from,
          toState: transition.to,
          reason: transition.reason,
          ...(transition.brokerStatus ? { brokerStatus: transition.brokerStatus } : {}),
          occurredAt: transition.occurredAt,
        },
      }),
      this.database.orderRecord.update({
        where: { id: orderId },
        data: {
          state: transition.to,
          reconciliationDue: transition.to === 'UNKNOWN',
        },
      }),
    ]);
  }

  public async saveBrokerResponse(
    orderId: string,
    response: ReturnType<typeof alpacaOrderSchema.parse>,
  ): Promise<void> {
    await this.database.orderRecord.update({
      where: { id: orderId },
      data: {
        brokerOrderId: response.id,
        brokerResponse: json(response),
        filledQuantity: response.filled_qty,
        ...(response.filled_avg_price ? { averageFillPrice: response.filled_avg_price } : {}),
      },
    });
  }

  public async updateIntentState(
    intentId: string,
    state: TradeIntentState,
    reasons: readonly string[],
  ): Promise<void> {
    await this.database.tradeIntentRecord.update({
      where: { id: intentId },
      data: { state, rejectionReasons: json(reasons) },
    });
  }

  public async saveResult(key: string, result: TradeExecutionResult): Promise<void> {
    await this.database.idempotencyRecord.upsert({
      where: { key },
      create: {
        key,
        operationType: 'TRADE_EXECUTION',
        entityId: result.intentId,
        state: result.intentState,
        result: json({
          intentId: result.intentId,
          intentState: result.intentState,
          ...(result.order === undefined ? {} : { orderId: result.order.id }),
          reasons: result.reasons,
          reconciliationRequired: result.reconciliationRequired,
        }),
      },
      update: {
        state: result.intentState,
        entityId: result.intentId,
        result: json({
          intentId: result.intentId,
          intentState: result.intentState,
          ...(result.order === undefined ? {} : { orderId: result.order.id }),
          reasons: result.reasons,
          reconciliationRequired: result.reconciliationRequired,
        }),
      },
    });
  }
}

export function createBrokerRequestRecorder(database: DatabaseClient) {
  return async (observation: BrokerRequestObservation): Promise<void> => {
    await database.brokerRequestRecord.create({
      data: {
        correlationId: observation.correlationId,
        ...(observation.brokerRequestId ? { brokerRequestId: observation.brokerRequestId } : {}),
        service: observation.service,
        method: observation.method,
        path: observation.path,
        ...(observation.statusCode === undefined ? {} : { statusCode: observation.statusCode }),
        latencyMs: observation.latencyMs,
        retryAttempt: observation.retryAttempt,
        outcome: observation.outcome,
      },
    });
  };
}
