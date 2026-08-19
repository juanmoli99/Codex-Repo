import type { Prisma } from '../generated/prisma/client.js';
import type { DatabaseClient } from '../database/client.js';
import { ConfigurationError } from '../core/errors.js';
import type {
  AuditEventInput,
  AuthOperator,
  AuthRepository,
  AuthSession,
  SessionCreation,
} from './auth-repository.js';

export class PrismaAuthRepository implements AuthRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async ensureSingleOperator(username: string, passwordHash: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const operators = await transaction.operator.findMany({ where: { active: true } });
      if (operators.length > 1) {
        throw new ConfigurationError(
          'MULTIPLE_ACTIVE_OPERATORS',
          'Single-operator invariant violated',
          [`Found ${operators.length} active operators`],
        );
      }
      const existing = operators[0];
      if (existing && existing.username !== username) {
        throw new ConfigurationError(
          'OPERATOR_IDENTITY_MISMATCH',
          'Configured operator does not match persisted operator',
          ['OPERATOR_USERNAME differs from the database identity'],
        );
      }
      if (!existing) {
        await transaction.operator.create({ data: { username, passwordHash } });
      } else if (existing.passwordHash !== passwordHash) {
        const now = new Date();
        await transaction.operator.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            passwordChangedAt: now,
            version: { increment: 1 },
          },
        });
        await transaction.session.updateMany({
          where: { operatorId: existing.id, state: 'ACTIVE' },
          data: { state: 'REVOKED', revokedAt: now },
        });
      }
    });
  }

  public async findOperator(username: string): Promise<AuthOperator | null> {
    return this.database.operator.findUnique({ where: { username } });
  }

  public async findOperatorById(id: string): Promise<AuthOperator | null> {
    return this.database.operator.findUnique({ where: { id } });
  }

  public async recordFailedLogin(operatorId: string, lockedUntil: Date | null): Promise<void> {
    await this.database.operator.update({
      where: { id: operatorId },
      data: { failedLoginCount: { increment: 1 }, lockedUntil, version: { increment: 1 } },
    });
  }

  public async recordSuccessfulLogin(operatorId: string, occurredAt: Date): Promise<void> {
    await this.database.operator.update({
      where: { id: operatorId },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastSuccessfulLogin: occurredAt,
        version: { increment: 1 },
      },
    });
  }

  public async createSession(input: SessionCreation): Promise<AuthSession> {
    return this.database.$transaction(async (transaction) => {
      await transaction.session.updateMany({
        where: { operatorId: input.operatorId, state: 'ACTIVE' },
        data: { state: 'REVOKED', revokedAt: new Date() },
      });
      return transaction.session.create({
        data: {
          operatorId: input.operatorId,
          tokenHash: input.tokenHash,
          csrfTokenHash: input.csrfTokenHash,
          expiresAt: input.expiresAt,
          ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
          ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        },
      });
    });
  }

  public async findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    return this.database.session.findUnique({
      where: { tokenHash },
    });
  }

  public async touchSession(sessionId: string, occurredAt: Date): Promise<void> {
    await this.database.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: occurredAt },
    });
  }

  public async revokeSession(sessionId: string, occurredAt: Date): Promise<void> {
    await this.database.session.update({
      where: { id: sessionId },
      data: { state: 'REVOKED', revokedAt: occurredAt },
    });
  }

  public async revokeAllSessions(operatorId: string, occurredAt: Date): Promise<number> {
    const result = await this.database.session.updateMany({
      where: { operatorId, state: 'ACTIVE' },
      data: { state: 'REVOKED', revokedAt: occurredAt },
    });
    return result.count;
  }

  public async appendAuditEvent(input: AuditEventInput): Promise<void> {
    const metadata = input.metadata as Prisma.InputJsonValue | undefined;
    await this.database.auditEvent.create({
      data: {
        severity: input.severity,
        action: input.action,
        resourceType: input.resourceType,
        correlationId: input.correlationId,
        outcome: input.outcome,
        ...(input.operatorId ? { operatorId: input.operatorId } : {}),
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        ...(metadata ? { metadata } : {}),
      },
    });
  }
}
