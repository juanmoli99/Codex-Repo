import type { DatabaseClient } from '../database/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Alert, AlertChannel, AlertRepository } from './service.js';

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class PrismaAlertRepository implements AlertRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async findActiveByFingerprint(fingerprint: string): Promise<Alert | undefined> {
    const record = await this.database.alertRecord.findUnique({ where: { fingerprint } });
    return record ? mapAlert(record) : undefined;
  }

  public async save(alert: Alert): Promise<void> {
    await this.database.alertRecord.upsert({
      where: { fingerprint: alert.fingerprint },
      create: {
        id: alert.id,
        fingerprint: alert.fingerprint,
        kind: alert.kind,
        severity: alert.severity,
        state: alert.state,
        title: alert.title,
        message: alert.message,
        component: alert.component,
        ...(alert.correlationId ? { correlationId: alert.correlationId } : {}),
        metadata: json(alert.metadata),
        occurrences: alert.occurrences,
        firstOccurredAt: alert.firstOccurredAt,
        lastOccurredAt: alert.lastOccurredAt,
        nextDeliveryAt: alert.nextDeliveryAt,
        deliveryAttempts: alert.deliveryAttempts,
        ...(alert.sentAt ? { sentAt: alert.sentAt } : {}),
        ...(alert.acknowledgedAt ? { acknowledgedAt: alert.acknowledgedAt } : {}),
        ...(alert.acknowledgedBy ? { acknowledgedBy: alert.acknowledgedBy } : {}),
      },
      update: {
        severity: alert.severity,
        state: alert.state,
        title: alert.title,
        message: alert.message,
        metadata: json(alert.metadata),
        occurrences: alert.occurrences,
        lastOccurredAt: alert.lastOccurredAt,
        nextDeliveryAt: alert.nextDeliveryAt,
        deliveryAttempts: alert.deliveryAttempts,
        sentAt: alert.sentAt ?? null,
        acknowledgedAt: alert.acknowledgedAt ?? null,
        acknowledgedBy: alert.acknowledgedBy ?? null,
      },
    });
  }

  public async listResolved(): Promise<readonly Alert[]> {
    return (
      await this.database.alertRecord.findMany({
        where: { state: 'ACKNOWLEDGED' },
        orderBy: { acknowledgedAt: 'desc' },
      })
    ).map(mapAlert);
  }

  public async listDue(now: Date, limit: number): Promise<readonly Alert[]> {
    return (
      await this.database.alertRecord.findMany({
        where: {
          state: { in: ['PENDING', 'FAILED'] },
          nextDeliveryAt: { lte: now },
        },
        orderBy: [{ severity: 'desc' }, { nextDeliveryAt: 'asc' }],
        take: limit,
      })
    ).map(mapAlert);
  }
}

type AlertRecordShape = NonNullable<
  Awaited<ReturnType<DatabaseClient['alertRecord']['findFirst']>>
>;

function mapAlert(record: AlertRecordShape): Alert {
  return {
    id: record.id,
    fingerprint: record.fingerprint,
    kind: record.kind as Alert['kind'],
    severity: record.severity,
    state: record.state,
    title: record.title,
    message: record.message,
    component: record.component,
    ...(record.correlationId ? { correlationId: record.correlationId } : {}),
    metadata:
      record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? record.metadata
        : {},
    occurrences: record.occurrences,
    firstOccurredAt: record.firstOccurredAt,
    lastOccurredAt: record.lastOccurredAt,
    nextDeliveryAt: record.nextDeliveryAt,
    deliveryAttempts: record.deliveryAttempts,
    ...(record.sentAt ? { sentAt: record.sentAt } : {}),
    ...(record.acknowledgedAt ? { acknowledgedAt: record.acknowledgedAt } : {}),
    ...(record.acknowledgedBy ? { acknowledgedBy: record.acknowledgedBy } : {}),
  };
}

export class RecordedAlertChannel implements AlertChannel {
  public readonly name: string;

  public constructor(
    private readonly database: DatabaseClient,
    private readonly delegate: AlertChannel,
  ) {
    this.name = delegate.name;
  }

  public async send(alert: Alert): Promise<void> {
    const attempt = alert.deliveryAttempts + 1;
    try {
      await this.delegate.send(alert);
      await this.record(alert.id, attempt, 'SENT');
    } catch (error) {
      await this.record(
        alert.id,
        attempt,
        'FAILED',
        error instanceof Error ? error.message : 'Unknown alert delivery error',
      );
      throw error;
    }
  }

  private async record(
    alertId: string,
    attempt: number,
    outcome: string,
    error?: string,
  ): Promise<void> {
    await this.database.alertDeliveryRecord.upsert({
      where: { alertId_channel_attempt: { alertId, channel: this.name, attempt } },
      create: {
        alertId,
        channel: this.name,
        attempt,
        outcome,
        ...(error ? { error } : {}),
        attemptedAt: new Date(),
      },
      update: { outcome, ...(error ? { error } : {}), attemptedAt: new Date() },
    });
  }
}

export class UnavailableAlertChannel implements AlertChannel {
  public constructor(public readonly name: string) {}

  public send(): Promise<void> {
    return Promise.reject(new Error(`${this.name} alert channel is not configured`));
  }
}
