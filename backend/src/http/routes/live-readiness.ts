import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { InputValidationError } from '../../core/errors.js';
import { verifyTotp } from '../../security/totp.js';
import { sessionCookieName } from '../session-cookie.js';
import type { AppDependencies } from '../types.js';

const challengeSchema = z.object({
  assessmentId: z.uuid(),
  confirmation: z.string(),
  reauthenticationPassword: z.string().min(16).max(1_024),
  totpCode: z.string().regex(/^\d{6}$/),
});
const activationSchema = z.object({
  challengeId: z.uuid(),
  nonce: z.string().regex(/^[0-9a-f]{64}$/i),
  confirmationPhrase: z.string(),
  manualMonitoringAcknowledged: z.literal(true),
  reauthenticationPassword: z.string().min(16).max(1_024),
  totpCode: z.string().regex(/^\d{6}$/),
});

function csrfHeader(request: FastifyRequest): string | undefined {
  const value = request.headers['x-csrf-token'];
  return Array.isArray(value) ? value[0] : value;
}

export function registerLiveReadinessRoutes(
  server: FastifyInstance,
  dependencies: AppDependencies,
): void {
  const service = dependencies.liveReadiness;
  if (service === undefined) return;
  const sessionCookie = sessionCookieName(dependencies.config);

  server.get('/api/live-readiness', async (request, reply) => {
    await dependencies.authService.authenticate(request.cookies[sessionCookie]);
    const assessment = await service.latest();
    return (
      assessment ??
      reply.code(404).send({
        error: {
          code: 'LIVE_ASSESSMENT_NOT_FOUND',
          message: 'No LIVE-readiness assessment exists',
          correlationId: request.id,
        },
      })
    );
  });

  server.post(
    '/api/live-readiness/assess',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const session = await dependencies.authService.authenticateWithCsrf(
        request.cookies[sessionCookie],
        csrfHeader(request),
      );
      const assessment = await service.assess(session.operatorId);
      return reply.code(201).send(assessment);
    },
  );

  server.post(
    '/api/live-readiness/challenge',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const session = await dependencies.authService.authenticateWithCsrf(
        request.cookies[sessionCookie],
        csrfHeader(request),
      );
      const input = challengeSchema.parse(request.body);
      await dependencies.authService.reauthenticate(
        session.operatorId,
        input.reauthenticationPassword,
        {
          correlationId: request.id,
          ipAddress: request.ip,
          ...(request.headers['user-agent'] === undefined
            ? {}
            : { userAgent: request.headers['user-agent'] }),
        },
      );
      assertLiveMfa(input.totpCode, dependencies);
      const challenge = await service.requestActivationChallenge({
        assessmentId: input.assessmentId,
        confirmation: input.confirmation,
        actor: session.operatorId,
      });
      return reply.code(201).send(challenge);
    },
  );

  server.post(
    '/api/live-readiness/activate',
    { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } },
    async (request) => {
      const session = await dependencies.authService.authenticateWithCsrf(
        request.cookies[sessionCookie],
        csrfHeader(request),
      );
      const input = activationSchema.parse(request.body);
      await dependencies.authService.reauthenticate(
        session.operatorId,
        input.reauthenticationPassword,
        {
          correlationId: request.id,
          ipAddress: request.ip,
          ...(request.headers['user-agent'] === undefined
            ? {}
            : { userAgent: request.headers['user-agent'] }),
        },
      );
      assertLiveMfa(input.totpCode, dependencies);
      const assessment = await service.activate({
        challengeId: input.challengeId,
        nonce: input.nonce,
        confirmationPhrase: input.confirmationPhrase,
        manualMonitoringAcknowledged: input.manualMonitoringAcknowledged,
        actor: session.operatorId,
      });
      await dependencies.operationsRuntime.activateLive({
        actor: session.operatorId,
        correlationId: request.id,
      });
      return assessment;
    },
  );
}

function assertLiveMfa(code: string, dependencies: AppDependencies): void {
  const secret = dependencies.config.security.operatorTotpSecret;
  if (!secret || !verifyTotp(code, secret))
    throw new InputValidationError(
      'MFA_REQUIRED',
      'A current six-digit TOTP code is required for LIVE activation',
    );
}
