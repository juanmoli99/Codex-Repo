import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, LogController } from 'fastify';

import { normalizeError } from '../core/errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerLiveReadinessRoutes } from './routes/live-readiness.js';
import { registerOperationsRoutes } from './routes/operations.js';
import type { AppDependencies } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function buildServer(dependencies: AppDependencies): Promise<FastifyInstance> {
  const server = Fastify({
    loggerInstance: dependencies.logger,
    bodyLimit: dependencies.config.app.maxPayloadBytes,
    trustProxy: dependencies.config.app.environment === 'production',
    requestIdHeader: 'x-correlation-id',
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    genReqId: (request) => {
      const proposed = request.headers['x-correlation-id'];
      return typeof proposed === 'string' && UUID_PATTERN.test(proposed) ? proposed : randomUUID();
    },
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    forceCloseConnections: 'idle',
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
  });

  await server.register(cookie);
  await server.register(helmet, {
    global: true,
    hsts:
      dependencies.config.app.environment === 'production'
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] },
    },
  });
  await server.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || dependencies.config.security.trustedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin rejected'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-correlation-id', 'x-csrf-token'],
    exposedHeaders: ['x-correlation-id'],
    maxAge: 600,
  });
  await server.register(rateLimit, { global: false });

  server.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    if (
      dependencies.config.app.environment === 'production' &&
      request.headers['x-forwarded-proto'] !== 'https'
    ) {
      return reply.code(426).send({
        error: { code: 'HTTPS_REQUIRED', message: 'HTTPS is required', correlationId: request.id },
      });
    }
  });

  server.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    request.log.error(
      {
        err: error,
        code: normalized.code,
        category: normalized.category,
        severity: normalized.severity,
      },
      'Request failed',
    );
    const publicMessage =
      normalized.statusCode >= 500 ? 'An internal error occurred' : normalized.message;
    void reply.code(normalized.statusCode).send({
      error: { code: normalized.code, message: publicMessage, correlationId: request.id },
    });
  });

  server.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found', correlationId: request.id },
    }),
  );

  registerHealthRoutes(server, dependencies);
  await registerAuthRoutes(server, dependencies);
  registerHistoryRoutes(server, dependencies);
  registerOperationsRoutes(server, dependencies);
  registerLiveReadinessRoutes(server, dependencies);
  return server;
}
