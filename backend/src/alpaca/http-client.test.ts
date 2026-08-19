import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '../core/config.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  AlpacaHttpClient,
  AlpacaNetworkError,
  AlpacaUnknownOutcomeError,
  type HttpTransport,
} from './http-client.js';
import { SharedRateBudget } from './rate-budget.js';

function config() {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://aegis:test@127.0.0.1:5432/aegis',
    OPERATOR_PASSWORD_HASH: 'x'.repeat(64),
    SESSION_SIGNING_SECRET: 's'.repeat(32),
    CSRF_SIGNING_SECRET: 'c'.repeat(32),
    ALPACA_PAPER_API_KEY: 'paper-key',
    ALPACA_PAPER_API_SECRET: 'paper-secret',
  });
}

describe('AlpacaHttpClient', () => {
  it('retries only safe requests with exponential backoff', async () => {
    let calls = 0;
    const transport: HttpTransport = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('network');
      return { status: 200, headers: new Headers(), body: { ok: true } };
    });
    const sleep = vi.fn(async () => undefined);
    const client = new AlpacaHttpClient(
      config(),
      new SharedRateBudget(100, 100),
      new CircuitBreaker(10),
      pino({ enabled: false }),
      transport,
      sleep,
      () => 0,
    );
    await expect(
      client.request({
        service: 'trading',
        method: 'GET',
        path: '/v2/account',
        schema: z.object({ ok: z.boolean() }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });

  it('never blindly retries a non-idempotent broker operation', async () => {
    const transport: HttpTransport = vi.fn(async () => {
      throw new Error('connection lost after write');
    });
    const client = new AlpacaHttpClient(
      config(),
      new SharedRateBudget(100, 100),
      new CircuitBreaker(10),
      pino({ enabled: false }),
      transport,
    );
    await expect(
      client.request({
        service: 'trading',
        method: 'POST',
        path: '/v2/orders',
        body: { symbol: 'SPY' },
        schema: z.unknown(),
        retryMode: 'NEVER',
        operationKey: 'aegis-order-1',
      }),
    ).rejects.toBeInstanceOf(AlpacaUnknownOutcomeError);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('classifies network failures as retryable', () => {
    expect(new AlpacaNetworkError().retryable).toBe(true);
  });
});
