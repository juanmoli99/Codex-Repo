import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { InputValidationError } from '../../core/errors.js';
import { sessionCookieName } from '../session-cookie.js';
import type { AppDependencies } from '../types.js';

const loginSchema = z.object({
  username: z.string().trim().min(3).max(128),
  password: z.string().min(1).max(1_024),
});

function userAgent(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header.join(' ').slice(0, 512) : header?.slice(0, 512);
}

export async function registerAuthRoutes(
  server: FastifyInstance,
  dependencies: AppDependencies,
): Promise<void> {
  const sessionCookie = sessionCookieName(dependencies.config);
  await server.register(async (scope) => {
    await scope.register(import('@fastify/rate-limit'), {
      max: dependencies.config.security.loginMaxAttempts,
      timeWindow: `${dependencies.config.security.loginLockMinutes} minutes`,
      keyGenerator: (request) => request.ip,
    });
    scope.post('/api/auth/login', async (request, reply) => {
      const input = loginSchema.safeParse(request.body);
      if (!input.success) {
        throw new InputValidationError('LOGIN_INPUT_INVALID', 'Invalid login payload');
      }
      const requestUserAgent = userAgent(request.headers['user-agent']);
      const result = await dependencies.authService.login(
        input.data.username,
        input.data.password,
        {
          correlationId: request.id,
          ipAddress: request.ip,
          ...(requestUserAgent ? { userAgent: requestUserAgent } : {}),
        },
      );
      reply.setCookie(sessionCookie, result.sessionToken, {
        path: '/',
        httpOnly: true,
        secure: dependencies.config.app.environment === 'production',
        sameSite: 'strict',
        expires: result.expiresAt,
      });
      return reply.send({
        operator: result.operator,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt.toISOString(),
      });
    });
  });

  server.post('/api/auth/logout', async (request, reply) => {
    const csrfHeader = request.headers['x-csrf-token'];
    const requestUserAgent = userAgent(request.headers['user-agent']);
    await dependencies.authService.logout(
      request.cookies[sessionCookie],
      Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader,
      {
        correlationId: request.id,
        ipAddress: request.ip,
        ...(requestUserAgent ? { userAgent: requestUserAgent } : {}),
      },
    );
    reply.clearCookie(sessionCookie, { path: '/' });
    return reply.code(204).send();
  });

  server.get('/api/auth/session', async (request) => {
    const session = await dependencies.authService.authenticate(request.cookies[sessionCookie]);
    return { authenticated: true, expiresAt: session.expiresAt.toISOString() };
  });
}
