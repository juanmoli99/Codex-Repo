import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../core/config.js';
import { AuthenticationError } from '../core/errors.js';
import { OperationalStateService } from '../core/operational-state.js';
import type { DatabaseClient } from '../database/client.js';
import type { AuthService } from '../security/auth-service.js';
import type { OperationsRuntime } from '../runtime/types.js';
import { buildServer } from './server.js';

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function subject(authService: AuthService = {} as AuthService) {
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://aegis:test@127.0.0.1:5432/aegis',
    OPERATOR_PASSWORD_HASH: 'x'.repeat(64),
    SESSION_SIGNING_SECRET: 's'.repeat(32),
    CSRF_SIGNING_SECRET: 'c'.repeat(32),
  });
  const operationalState = new OperationalStateService();
  await operationalState.transition('READY', 'TEST_READY', 'test');
  const database = {
    $queryRaw: () => Promise.resolve([{ value: 1 }]),
    brokerRequestRecord: { findFirst: () => Promise.resolve(null) },
    marketDataStateRecord: { findMany: () => Promise.resolve([]) },
    reconciliationRecord: { findFirst: () => Promise.resolve(null) },
    orderRecord: { count: () => Promise.resolve(0) },
    marketClockRecord: { findUnique: () => Promise.resolve(null) },
    workerHeartbeatRecord: { findFirst: () => Promise.resolve(null) },
  } as unknown as DatabaseClient;
  const server = await buildServer({
    config,
    operationalState,
    database,
    authService,
    operationsRuntime: {} as OperationsRuntime,
    logger: pino({ enabled: false }),
  });
  servers.push(server);
  return server;
}

describe('HTTP security foundation', () => {
  it('uses a browser-compatible local cookie without weakening the production cookie', async () => {
    const server = await subject({
      login: vi.fn(async () => ({
        operator: { id: 'operator', username: 'operator' },
        sessionToken: 'session-token',
        csrfToken: 'csrf-token',
        expiresAt: new Date(Date.now() + 60_000),
      })),
    } as unknown as AuthService);
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'operator', password: 'password' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toMatch(/^aegis_session=/);
    expect(response.headers['set-cookie']).not.toContain('Secure');
  });

  it('serves liveness and readiness with security and correlation headers', async () => {
    const server = await subject();
    const liveness = await server.inject({ method: 'GET', url: '/health/live' });
    expect(liveness.statusCode).toBe(200);
    expect(liveness.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(liveness.headers['x-content-type-options']).toBe('nosniff');

    const readiness = await server.inject({ method: 'GET', url: '/health/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: 'UNKNOWN',
      systemState: 'READY',
      mode: 'PAPER',
    });
  });

  it('does not expose stack traces for unknown routes', async () => {
    const server = await subject();
    const response = await server.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('stack');
    expect(response.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
  });

  it('protects operations queries and requires strong confirmation for critical actions', async () => {
    const authenticate = vi.fn(async () => {
      throw new AuthenticationError();
    });
    const unauthorizedServer = await subject({ authenticate } as unknown as AuthService);
    expect(
      (await unauthorizedServer.inject({ method: 'GET', url: '/api/operations/snapshot' }))
        .statusCode,
    ).toBe(401);

    const authenticatedServer = await subject({
      authenticateWithCsrf: vi.fn(async () => ({
        sessionId: 'session',
        operatorId: '00000000-0000-4000-8000-000000000001',
        expiresAt: new Date(Date.now() + 60_000),
      })),
    } as unknown as AuthService);
    const response = await authenticatedServer.inject({
      method: 'POST',
      url: '/api/operations/actions/kill-switch',
      headers: { cookie: '__Host-aegis_session=session', 'x-csrf-token': 'csrf' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'STRONG_CONFIRMATION_REQUIRED' } });
  });
});
