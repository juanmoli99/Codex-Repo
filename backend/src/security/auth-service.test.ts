import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { AuthenticationError, AuthorizationError } from '../core/errors.js';
import type {
  AuditEventInput,
  AuthOperator,
  AuthRepository,
  AuthSession,
  SessionCreation,
} from './auth-repository.js';
import { AuthService } from './auth-service.js';
import { hashPassword } from './crypto.js';

class MemoryAuthRepository implements AuthRepository {
  public operator!: AuthOperator;
  public readonly sessions = new Map<string, AuthSession>();
  public readonly audit: AuditEventInput[] = [];

  public async ensureSingleOperator(username: string, passwordHash: string): Promise<void> {
    this.operator = {
      id: randomUUID(),
      username,
      passwordHash,
      active: true,
      failedLoginCount: 0,
      lockedUntil: null,
    };
  }

  public async findOperator(username: string): Promise<AuthOperator | null> {
    return this.operator.username === username ? this.operator : null;
  }

  public async findOperatorById(id: string): Promise<AuthOperator | null> {
    return this.operator.id === id ? this.operator : null;
  }

  public async recordFailedLogin(_operatorId: string, lockedUntil: Date | null): Promise<void> {
    this.operator = {
      ...this.operator,
      failedLoginCount: this.operator.failedLoginCount + 1,
      lockedUntil,
    };
  }

  public async recordSuccessfulLogin(_operatorId: string, _occurredAt: Date): Promise<void> {
    this.operator = { ...this.operator, failedLoginCount: 0, lockedUntil: null };
  }

  public async createSession(input: SessionCreation): Promise<AuthSession> {
    await this.revokeAllSessions(input.operatorId, new Date());
    const session: AuthSession = {
      id: randomUUID(),
      operatorId: input.operatorId,
      tokenHash: input.tokenHash,
      csrfTokenHash: input.csrfTokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.set(input.tokenHash, session);
    return session;
  }

  public async findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  public async touchSession(_sessionId: string, _occurredAt: Date): Promise<void> {}

  public async revokeSession(sessionId: string, occurredAt: Date): Promise<void> {
    const match = [...this.sessions.entries()].find(([, session]) => session.id === sessionId);
    if (match) this.sessions.set(match[0], { ...match[1], revokedAt: occurredAt });
  }

  public async revokeAllSessions(operatorId: string, occurredAt: Date): Promise<number> {
    let count = 0;
    for (const [token, session] of this.sessions) {
      if (session.operatorId === operatorId && !session.revokedAt) {
        this.sessions.set(token, { ...session, revokedAt: occurredAt });
        count += 1;
      }
    }
    return count;
  }

  public async appendAuditEvent(input: AuditEventInput): Promise<void> {
    this.audit.push(input);
  }
}

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword('correct horse battery staple');
});

async function subject(maximumAttempts = 5): Promise<{
  readonly service: AuthService;
  readonly repository: MemoryAuthRepository;
}> {
  const repository = new MemoryAuthRepository();
  await repository.ensureSingleOperator('operator', passwordHash);
  return {
    repository,
    service: new AuthService(repository, maximumAttempts, 15, 30, passwordHash),
  };
}

describe('AuthService', () => {
  it('creates, authenticates, CSRF-protects, and revokes a session', async () => {
    const { service } = await subject();
    const context = { correlationId: randomUUID(), ipAddress: '127.0.0.1' };
    const login = await service.login('operator', 'correct horse battery staple', context);
    await expect(service.authenticate(login.sessionToken)).resolves.toMatchObject({
      operatorId: login.operator.id,
    });
    await expect(
      service.authenticateWithCsrf(login.sessionToken, 'incorrect-csrf'),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await service.logout(login.sessionToken, login.csrfToken, context);
    await expect(service.authenticate(login.sessionToken)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('locks the identity after repeated failures', async () => {
    const { service, repository } = await subject(3);
    const context = { correlationId: randomUUID() };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.login('operator', 'wrong', context)).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    }
    expect(repository.operator.lockedUntil).toBeInstanceOf(Date);
    await expect(
      service.login('operator', 'correct horse battery staple', context),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_LOCKED' });
  });

  it('rotates the single-operator session on a new login', async () => {
    const { service } = await subject();
    const context = { correlationId: randomUUID() };
    const first = await service.login('operator', 'correct horse battery staple', context);
    const second = await service.login('operator', 'correct horse battery staple', context);

    await expect(service.authenticate(first.sessionToken)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(service.authenticate(second.sessionToken)).resolves.toBeDefined();
  });
});
