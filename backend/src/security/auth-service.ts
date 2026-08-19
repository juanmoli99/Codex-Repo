import { AuthenticationError, AuthorizationError } from '../core/errors.js';
import type { AuthRepository, AuthSession } from './auth-repository.js';
import {
  constantTimeTokenMatches,
  createOpaqueToken,
  hashToken,
  verifyPassword,
} from './crypto.js';

export interface RequestContext {
  readonly correlationId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface LoginResult {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
  readonly operator: { readonly id: string; readonly username: string };
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly expiresAt: Date;
}

export class AuthService {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly maximumAttempts: number,
    private readonly lockMinutes: number,
    private readonly sessionTtlMinutes: number,
    private readonly dummyPasswordHash: string,
  ) {}

  public async login(
    username: string,
    password: string,
    context: RequestContext,
  ): Promise<LoginResult> {
    const now = new Date();
    const operator = await this.repository.findOperator(username);
    const passwordMatches = await verifyPassword(
      operator?.passwordHash ?? this.dummyPasswordHash,
      password,
    );
    if (!operator || !operator.active || !passwordMatches) {
      if (operator) {
        const nextAttempt = operator.failedLoginCount + 1;
        const lockedUntil =
          nextAttempt >= this.maximumAttempts
            ? new Date(now.getTime() + this.lockMinutes * 60_000)
            : null;
        await this.repository.recordFailedLogin(operator.id, lockedUntil);
      }
      await this.repository.appendAuditEvent({
        severity: 'WARNING',
        action: 'AUTH_LOGIN',
        resourceType: 'SESSION',
        correlationId: context.correlationId,
        outcome: 'REJECTED',
        ...(operator ? { operatorId: operator.id } : {}),
        ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
        ...(context.userAgent ? { userAgent: context.userAgent } : {}),
        metadata: { reason: 'INVALID_CREDENTIALS' },
      });
      throw new AuthenticationError();
    }
    if (operator.lockedUntil && operator.lockedUntil > now) {
      throw new AuthenticationError('AUTHENTICATION_LOCKED', 'Authentication temporarily locked');
    }

    const sessionToken = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMinutes * 60_000);
    const session = await this.repository.createSession({
      operatorId: operator.id,
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      expiresAt,
      ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
    });
    await this.repository.recordSuccessfulLogin(operator.id, now);
    await this.repository.appendAuditEvent({
      operatorId: operator.id,
      severity: 'INFO',
      action: 'AUTH_LOGIN',
      resourceType: 'SESSION',
      resourceId: session.id,
      correlationId: context.correlationId,
      outcome: 'SUCCEEDED',
      ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
    });
    return {
      sessionToken,
      csrfToken,
      expiresAt,
      operator: { id: operator.id, username: operator.username },
    };
  }

  public async authenticate(sessionToken: string | undefined): Promise<AuthenticatedSession> {
    if (!sessionToken) throw new AuthenticationError();
    const now = new Date();
    const session = await this.repository.findSessionByTokenHash(hashToken(sessionToken));
    if (!session || session.revokedAt || session.expiresAt <= now) throw new AuthenticationError();
    await this.repository.touchSession(session.id, now);
    return { sessionId: session.id, operatorId: session.operatorId, expiresAt: session.expiresAt };
  }

  public assertCsrf(session: AuthSession, csrfToken: string | undefined): void {
    if (!csrfToken || !constantTimeTokenMatches(csrfToken, session.csrfTokenHash)) {
      throw new AuthorizationError('CSRF_VALIDATION_FAILED', 'CSRF validation failed');
    }
  }

  public async authenticateWithCsrf(
    sessionToken: string | undefined,
    csrfToken: string | undefined,
  ): Promise<AuthenticatedSession> {
    if (!sessionToken) throw new AuthenticationError();
    const session = await this.repository.findSessionByTokenHash(hashToken(sessionToken));
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new AuthenticationError();
    }
    this.assertCsrf(session, csrfToken);
    await this.repository.touchSession(session.id, new Date());
    return { sessionId: session.id, operatorId: session.operatorId, expiresAt: session.expiresAt };
  }

  public async reauthenticate(
    operatorId: string,
    password: string,
    context: RequestContext,
  ): Promise<void> {
    const operator = await this.repository.findOperatorById(operatorId);
    const matches = await verifyPassword(
      operator?.passwordHash ?? this.dummyPasswordHash,
      password,
    );
    if (!operator || !operator.active || !matches) {
      await this.repository.appendAuditEvent({
        ...(operator ? { operatorId: operator.id } : {}),
        severity: 'CRITICAL',
        action: 'AUTH_REAUTHENTICATE',
        resourceType: 'OPERATOR',
        correlationId: context.correlationId,
        outcome: 'REJECTED',
      });
      throw new AuthenticationError('REAUTHENTICATION_FAILED', 'Reauthentication failed');
    }
    await this.repository.appendAuditEvent({
      operatorId,
      severity: 'INFO',
      action: 'AUTH_REAUTHENTICATE',
      resourceType: 'OPERATOR',
      resourceId: operatorId,
      correlationId: context.correlationId,
      outcome: 'SUCCEEDED',
    });
  }

  public async logout(
    sessionToken: string | undefined,
    csrfToken: string | undefined,
    context: RequestContext,
  ): Promise<void> {
    const authenticated = await this.authenticateWithCsrf(sessionToken, csrfToken);
    await this.repository.revokeSession(authenticated.sessionId, new Date());
    await this.repository.appendAuditEvent({
      operatorId: authenticated.operatorId,
      severity: 'INFO',
      action: 'AUTH_LOGOUT',
      resourceType: 'SESSION',
      resourceId: authenticated.sessionId,
      correlationId: context.correlationId,
      outcome: 'SUCCEEDED',
      ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
    });
  }
}
