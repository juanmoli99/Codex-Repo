import { createHash, randomUUID } from 'node:crypto';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
export type AlertState = 'PENDING' | 'SENT' | 'FAILED' | 'ACKNOWLEDGED';
export type AlertKind =
  | 'HEARTBEAT'
  | 'ALPACA_DISCONNECTED'
  | 'MARKET_DATA_DOWN'
  | 'DATABASE_DOWN'
  | 'SCHEDULER_STOPPED'
  | 'SCANNER_FAILED'
  | 'ORDER_REJECTED'
  | 'ORDER_UNKNOWN'
  | 'PARTIAL_FILL_PROLONGED'
  | 'RECONCILIATION_MISMATCH'
  | 'UNEXPECTED_POSITION'
  | 'UNEXPECTED_FILL'
  | 'DAILY_LOSS_REACHED'
  | 'DRAWDOWN_REACHED'
  | 'CIRCUIT_BREAKER_OPEN'
  | 'KILL_SWITCH_ACTIVE'
  | 'MARKET_DATA_STALE'
  | 'REPEATED_ERROR'
  | 'LIVE_ACTIVATED'
  | 'SYSTEM_BLOCKED'
  | 'SYSTEM_EMERGENCY';

export interface Alert {
  readonly id: string;
  readonly fingerprint: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly state: AlertState;
  readonly title: string;
  readonly message: string;
  readonly component: string;
  readonly correlationId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurrences: number;
  readonly firstOccurredAt: Date;
  readonly lastOccurredAt: Date;
  readonly nextDeliveryAt: Date;
  readonly deliveryAttempts: number;
  readonly sentAt?: Date;
  readonly acknowledgedAt?: Date;
  readonly acknowledgedBy?: string;
}

export interface AlertRepository {
  findActiveByFingerprint(fingerprint: string): Promise<Alert | undefined>;
  save(alert: Alert): Promise<void>;
  listDue(now: Date, limit: number): Promise<readonly Alert[]>;
  listResolved(): Promise<readonly Alert[]>;
}

export interface AlertChannel {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

export interface AlertServiceOptions {
  readonly throttleMs: number;
  readonly maximumDeliveryAttempts: number;
  readonly retryBaseMs: number;
  readonly escalateAfterOccurrences: number;
}

const severityOrder: readonly AlertSeverity[] = ['INFO', 'WARNING', 'CRITICAL', 'EMERGENCY'];

export class AlertService {
  public constructor(
    private readonly repository: AlertRepository,
    private readonly primary: AlertChannel,
    private readonly secondary: AlertChannel,
    private readonly options: AlertServiceOptions,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  public async raise(input: {
    kind: AlertKind;
    severity: AlertSeverity;
    title: string;
    message: string;
    component: string;
    deduplicationScope: string;
    occurredAt: Date;
    correlationId?: string;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<Alert> {
    const fingerprint = createHash('sha256')
      .update(`${input.kind}|${input.component}|${input.deduplicationScope}`)
      .digest('hex');
    const existing = await this.repository.findActiveByFingerprint(fingerprint);
    const reopening = existing?.state === 'ACKNOWLEDGED';
    const occurrences = (existing?.occurrences ?? 0) + 1;
    const escalationSteps = Math.floor(occurrences / this.options.escalateAfterOccurrences);
    const baseSeverityIndex = severityOrder.indexOf(input.severity);
    const severity =
      severityOrder[Math.min(severityOrder.length - 1, baseSeverityIndex + escalationSteps)];
    if (severity === undefined) throw new Error('Invalid alert severity');
    const throttled =
      !reopening &&
      existing?.sentAt !== undefined &&
      input.occurredAt.getTime() - existing.sentAt.getTime() < this.options.throttleMs;
    const throttleUntil =
      existing?.sentAt === undefined
        ? new Date(input.occurredAt)
        : new Date(existing.sentAt.getTime() + this.options.throttleMs);
    const alert: Alert = {
      id: existing?.id ?? this.idFactory(),
      fingerprint,
      kind: input.kind,
      severity,
      state: throttled ? existing.state : 'PENDING',
      title: input.title,
      message: input.message,
      component: input.component,
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      metadata: Object.freeze({ ...(input.metadata ?? {}) }),
      occurrences,
      firstOccurredAt: existing?.firstOccurredAt ?? new Date(input.occurredAt),
      lastOccurredAt: new Date(input.occurredAt),
      nextDeliveryAt: throttled ? throttleUntil : new Date(input.occurredAt),
      deliveryAttempts: existing?.deliveryAttempts ?? 0,
      ...(existing?.sentAt === undefined ? {} : { sentAt: existing.sentAt }),
      ...(reopening || existing?.acknowledgedAt === undefined
        ? {}
        : { acknowledgedAt: existing.acknowledgedAt }),
      ...(reopening || existing?.acknowledgedBy === undefined
        ? {}
        : { acknowledgedBy: existing.acknowledgedBy }),
    };
    await this.repository.save(alert);
    return throttled ? alert : this.deliver(alert, input.occurredAt);
  }

  public async retryDue(now: Date, limit = 100): Promise<readonly Alert[]> {
    const alerts = await this.repository.listDue(now, limit);
    const delivered: Alert[] = [];
    for (const alert of alerts) delivered.push(await this.deliver(alert, now));
    return delivered;
  }

  public async deliver(alert: Alert, now: Date): Promise<Alert> {
    if (alert.state === 'ACKNOWLEDGED' || alert.nextDeliveryAt > now) return alert;
    if (alert.state === 'FAILED' && alert.deliveryAttempts >= this.options.maximumDeliveryAttempts)
      return alert;
    let lastError: unknown;
    for (const channel of [this.primary, this.secondary]) {
      try {
        await channel.send(alert);
        const sent: Alert = {
          ...alert,
          state: 'SENT',
          deliveryAttempts: alert.deliveryAttempts + 1,
          sentAt: new Date(now),
        };
        await this.repository.save(sent);
        return sent;
      } catch (error) {
        lastError = error;
      }
    }
    const attempts = alert.deliveryAttempts + 1;
    const failed: Alert = {
      ...alert,
      state: 'FAILED',
      deliveryAttempts: attempts,
      nextDeliveryAt: new Date(
        now.getTime() + this.options.retryBaseMs * 2 ** Math.min(attempts - 1, 10),
      ),
      metadata: Object.freeze({
        ...alert.metadata,
        deliveryError: lastError instanceof Error ? lastError.message : 'Alert delivery failed',
        terminal: attempts >= this.options.maximumDeliveryAttempts,
      }),
    };
    await this.repository.save(failed);
    return failed;
  }

  public async acknowledge(alert: Alert, actor: string, at: Date): Promise<Alert> {
    const acknowledged: Alert = {
      ...alert,
      state: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(at),
      acknowledgedBy: actor,
    };
    await this.repository.save(acknowledged);
    return acknowledged;
  }
}

export class TelegramAlertChannel implements AlertChannel {
  public readonly name = 'telegram';

  public constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  public async send(alert: Alert): Promise<void> {
    const response = await this.transport(
      `https://api.telegram.org/bot${encodeURIComponent(this.botToken)}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: `[${alert.severity}] ${alert.title}\n${alert.message}\nID: ${alert.id}`,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Telegram alert delivery failed with HTTP ${response.status}`);
  }
}

export class EmailAlertChannel implements AlertChannel {
  public readonly name = 'email';

  public constructor(
    private readonly recipient: string,
    private readonly sendEmail: (message: {
      to: string;
      subject: string;
      text: string;
    }) => Promise<void>,
  ) {}

  public send(alert: Alert): Promise<void> {
    return this.sendEmail({
      to: this.recipient,
      subject: `[AEGIS ${alert.severity}] ${alert.title}`,
      text: `${alert.message}\n\nAlert ID: ${alert.id}\nComponent: ${alert.component}`,
    });
  }
}
