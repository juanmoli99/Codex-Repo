export interface AuthOperator {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly active: boolean;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
}

export interface AuthSession {
  readonly id: string;
  readonly operatorId: string;
  readonly tokenHash: string;
  readonly csrfTokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface SessionCreation {
  readonly operatorId: string;
  readonly tokenHash: string;
  readonly csrfTokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface AuditEventInput {
  readonly operatorId?: string;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly correlationId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly outcome: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AuthRepository {
  ensureSingleOperator(username: string, passwordHash: string): Promise<void>;
  findOperator(username: string): Promise<AuthOperator | null>;
  findOperatorById(id: string): Promise<AuthOperator | null>;
  recordFailedLogin(operatorId: string, lockedUntil: Date | null): Promise<void>;
  recordSuccessfulLogin(operatorId: string, occurredAt: Date): Promise<void>;
  createSession(input: SessionCreation): Promise<AuthSession>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null>;
  touchSession(sessionId: string, occurredAt: Date): Promise<void>;
  revokeSession(sessionId: string, occurredAt: Date): Promise<void>;
  revokeAllSessions(operatorId: string, occurredAt: Date): Promise<number>;
  appendAuditEvent(input: AuditEventInput): Promise<void>;
}
