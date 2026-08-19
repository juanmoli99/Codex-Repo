import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { ZodType } from 'zod';

import type { AppConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { RateBudget } from './rate-budget.js';

export class AlpacaHttpError extends AppError {
  public constructor(
    public readonly httpStatus: number,
    public readonly brokerRequestId: string | undefined,
    public readonly responseBody: unknown,
    retryable: boolean,
  ) {
    super(
      httpStatus === 401 || httpStatus === 403
        ? 'ALPACA_AUTHENTICATION_FAILED'
        : 'ALPACA_HTTP_ERROR',
      `Alpaca returned HTTP ${httpStatus}`,
      502,
      'DEPENDENCY',
      httpStatus >= 500 ? 'CRITICAL' : 'WARNING',
      retryable,
    );
  }
}

export class AlpacaNetworkError extends AppError {
  public constructor(options?: ErrorOptions) {
    super(
      'ALPACA_NETWORK_ERROR',
      'Alpaca request failed before a response was received',
      503,
      'DEPENDENCY',
      'CRITICAL',
      true,
      options,
    );
  }
}

export class AlpacaUnknownOutcomeError extends AppError {
  public constructor(
    public readonly operationKey: string,
    options?: ErrorOptions,
  ) {
    super(
      'ALPACA_OPERATION_OUTCOME_UNKNOWN',
      'Broker operation outcome is unknown and must be reconciled before retry',
      503,
      'DEPENDENCY',
      'CRITICAL',
      false,
      options,
    );
  }
}

export interface HttpTransportRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export interface HttpTransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export type HttpTransport = (request: HttpTransportRequest) => Promise<HttpTransportResponse>;

const defaultTransport: HttpTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: request.body } : {}),
    signal: request.signal,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    body = { unparseable: true };
  }
  return { status: response.status, headers: response.headers, body };
};

export interface AlpacaRequest<T> {
  readonly service: 'trading' | 'data';
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly schema: ZodType<T>;
  readonly timeoutMs?: number;
  readonly rateCost?: number;
  readonly retryMode?: 'SAFE' | 'NEVER';
  readonly operationKey?: string;
  readonly correlationId?: string;
}

export type AlpacaAccessMode = 'READ_ONLY' | 'TRADING';

export interface BrokerRequestObservation {
  readonly correlationId: string;
  readonly brokerRequestId?: string;
  readonly service: 'trading' | 'data';
  readonly method: AlpacaRequest<unknown>['method'];
  readonly path: string;
  readonly statusCode?: number;
  readonly latencyMs: number;
  readonly retryAttempt: number;
  readonly outcome: 'SUCCEEDED' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'INVALID_RESPONSE';
}

const READ_ONLY_ENDPOINTS: readonly RegExp[] = [
  /^\/v2\/account$/,
  /^\/v2\/clock$/,
  /^\/v2\/calendar$/,
  /^\/v2\/assets(?:\/[^/]+)?$/,
  /^\/v2\/orders(?:\/[^/]+)?$/,
  /^\/v2\/positions$/,
  /^\/v2\/account\/activities(?:\/[^/]+)?$/,
  /^\/v2\/stocks\/(?:bars|quotes|trades)(?:\/latest)?$/,
  /^\/v1\/corporate-actions$/,
];

function endpointAllowed(request: AlpacaRequest<unknown>, mode: AlpacaAccessMode): boolean {
  if (request.method === 'GET')
    return READ_ONLY_ENDPOINTS.some((pattern) => pattern.test(request.path));
  if (mode !== 'TRADING' || request.service !== 'trading') return false;
  return (
    (request.method === 'POST' && request.path === '/v2/orders') ||
    (request.method === 'DELETE' && /^\/v2\/orders(?:\/[^/]+)?$/.test(request.path)) ||
    (request.method === 'PATCH' && /^\/v2\/orders\/[^/]+$/.test(request.path))
  );
}

export class AlpacaHttpClient {
  public constructor(
    private readonly config: AppConfig,
    private readonly budget: RateBudget,
    private readonly breaker: CircuitBreaker,
    private readonly logger: Logger,
    private readonly transport: HttpTransport = defaultTransport,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly random: () => number = Math.random,
    private readonly accessMode: AlpacaAccessMode = 'TRADING',
    private readonly observe?: (observation: BrokerRequestObservation) => Promise<void>,
  ) {}

  public circuitState() {
    return this.breaker.state();
  }

  public async request<T>(request: AlpacaRequest<T>): Promise<T> {
    if (!endpointAllowed(request, this.accessMode))
      throw new AppError(
        'ALPACA_ENDPOINT_NOT_ALLOWED',
        `${request.method} ${request.path} is not allowed for ${this.accessMode}`,
        403,
        'AUTHORIZATION',
        'CRITICAL',
      );
    const retryMode = request.retryMode ?? (request.method === 'GET' ? 'SAFE' : 'NEVER');
    const maximumAttempts = retryMode === 'SAFE' ? 4 : 1;
    let lastError: unknown;
    const correlationId = request.correlationId ?? randomUUID();

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      await this.budget.acquire(request.rateCost ?? 1);
      try {
        return await this.breaker.execute(() =>
          this.executeOnce({ ...request, correlationId }, attempt),
        );
      } catch (error) {
        lastError = error;
        const retryable =
          retryMode === 'SAFE' &&
          (error instanceof AlpacaNetworkError ||
            (error instanceof AlpacaHttpError && error.retryable));
        if (!retryable || attempt === maximumAttempts) {
          if (
            retryMode === 'NEVER' &&
            error instanceof AlpacaNetworkError &&
            request.operationKey
          ) {
            throw new AlpacaUnknownOutcomeError(request.operationKey, { cause: error });
          }
          throw error;
        }
        const exponentialMs = Math.min(5_000, 250 * 2 ** (attempt - 1));
        const jitterMs = Math.round(exponentialMs * 0.25 * this.random());
        await this.sleep(exponentialMs + jitterMs);
      }
    }
    throw lastError;
  }

  private async executeOnce<T>(request: AlpacaRequest<T>, attempt: number): Promise<T> {
    const baseUrl =
      request.service === 'data'
        ? this.config.alpaca.dataBaseUrl
        : this.config.trading.mode === 'PAPER'
          ? this.config.alpaca.paperBaseUrl
          : this.config.alpaca.liveBaseUrl;
    const apiKey =
      this.config.trading.mode === 'PAPER'
        ? this.config.alpaca.paperKey
        : this.config.alpaca.liveKey;
    const apiSecret =
      this.config.trading.mode === 'PAPER'
        ? this.config.alpaca.paperSecret
        : this.config.alpaca.liveSecret;
    if (!apiKey || !apiSecret) {
      throw new AppError(
        'ALPACA_CREDENTIALS_UNAVAILABLE',
        'Alpaca credentials are unavailable for the selected mode',
        503,
        'CONFIGURATION',
        'CRITICAL',
      );
    }
    const url = new URL(request.path, baseUrl);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeoutMs = request.timeoutMs ?? 8_000;
    const startedAt = performance.now();
    let response: HttpTransportResponse;
    try {
      response = await this.transport({
        url: url.toString(),
        method: request.method,
        headers: {
          'APCA-API-KEY-ID': apiKey,
          'APCA-API-SECRET-KEY': apiSecret,
          Accept: 'application/json',
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      await this.observe?.({
        correlationId: request.correlationId ?? randomUUID(),
        service: request.service,
        method: request.method,
        path: request.path,
        latencyMs: Math.round(performance.now() - startedAt),
        retryAttempt: attempt,
        outcome: 'NETWORK_ERROR',
      });
      throw new AlpacaNetworkError({ cause: error });
    }

    const brokerRequestId = response.headers.get('x-request-id') ?? undefined;
    const latencyMs = Math.round(performance.now() - startedAt);
    this.logger.debug(
      {
        service: request.service,
        method: request.method,
        path: request.path,
        status: response.status,
        latencyMs,
        brokerRequestId,
      },
      'Alpaca request completed',
    );
    if (response.status < 200 || response.status >= 300) {
      await this.observe?.({
        correlationId: request.correlationId ?? randomUUID(),
        ...(brokerRequestId ? { brokerRequestId } : {}),
        service: request.service,
        method: request.method,
        path: request.path,
        statusCode: response.status,
        latencyMs,
        retryAttempt: attempt,
        outcome: 'HTTP_ERROR',
      });
      throw new AlpacaHttpError(
        response.status,
        brokerRequestId,
        response.body,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const parsed = request.schema.safeParse(response.body);
    if (!parsed.success) {
      await this.observe?.({
        correlationId: request.correlationId ?? randomUUID(),
        ...(brokerRequestId ? { brokerRequestId } : {}),
        service: request.service,
        method: request.method,
        path: request.path,
        statusCode: response.status,
        latencyMs,
        retryAttempt: attempt,
        outcome: 'INVALID_RESPONSE',
      });
      throw new AppError(
        'ALPACA_RESPONSE_INVALID',
        'Alpaca response did not match the expected contract',
        502,
        'DEPENDENCY',
        'CRITICAL',
      );
    }
    await this.observe?.({
      correlationId: request.correlationId ?? randomUUID(),
      ...(brokerRequestId ? { brokerRequestId } : {}),
      service: request.service,
      method: request.method,
      path: request.path,
      statusCode: response.status,
      latencyMs,
      retryAttempt: attempt,
      outcome: 'SUCCEEDED',
    });
    return parsed.data;
  }
}
