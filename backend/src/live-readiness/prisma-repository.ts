import { createHash, randomUUID } from 'node:crypto';

import type { DatabaseClient } from '../database/client.js';
import type {
  LiveActivationChallenge,
  LiveReadinessAssessment,
  LiveReadinessCheck,
  LiveReadinessCheckCode,
  LiveReadinessRepository,
} from './service.js';

export class PrismaLiveReadinessRepository implements LiveReadinessRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async saveAssessment(assessment: LiveReadinessAssessment): Promise<void> {
    await this.database.liveReadinessRecord.create({
      data: {
        id: assessment.id,
        state: assessment.state,
        tradingMode: assessment.tradingMode,
        environment: assessment.environment,
        configurationChecksum: assessment.configurationChecksum,
        limits: assessment.limits,
        failureCodes: [...assessment.failureCodes],
        assessedBy: assessment.assessedBy,
        assessedAt: assessment.assessedAt,
        expiresAt: assessment.expiresAt,
        checks: {
          create: assessment.checks.map((check) => ({
            code: check.code,
            requirement: check.requirement,
            mandatory: check.mandatory,
            passed: check.passed,
            evidence: check.evidence,
            checkedAt: check.checkedAt,
          })),
        },
      },
    });
  }

  public async latestAssessment(): Promise<LiveReadinessAssessment | undefined> {
    const record = await this.database.liveReadinessRecord.findFirst({
      orderBy: { assessedAt: 'desc' },
      include: { checks: { orderBy: [{ requirement: 'asc' }, { code: 'asc' }] } },
    });
    if (record === null) return undefined;
    return {
      id: record.id,
      state: record.state,
      tradingMode: record.tradingMode,
      environment: record.environment,
      configurationChecksum: record.configurationChecksum,
      limits: record.limits as unknown as LiveReadinessAssessment['limits'],
      failureCodes: record.failureCodes as unknown as readonly LiveReadinessCheckCode[],
      assessedBy: record.assessedBy,
      assessedAt: record.assessedAt,
      expiresAt: record.expiresAt,
      ...(record.activatedAt === null ? {} : { activatedAt: record.activatedAt }),
      checks: record.checks.map((check): LiveReadinessCheck => ({
        code: check.code as LiveReadinessCheckCode,
        requirement: check.requirement,
        mandatory: true,
        passed: check.passed,
        evidence: check.evidence,
        checkedAt: check.checkedAt,
      })),
    };
  }

  public async saveChallenge(challenge: LiveActivationChallenge): Promise<void> {
    await this.database.liveActivationRecord.create({
      data: {
        id: challenge.id,
        assessmentId: challenge.assessmentId,
        actor: challenge.actor,
        nonceHash: challenge.nonceHash,
        outcome: challenge.outcome,
        challengeExpiresAt: challenge.challengeExpiresAt,
        limits: challenge.limits,
      },
    });
  }

  public async findChallenge(id: string): Promise<LiveActivationChallenge | undefined> {
    const record = await this.database.liveActivationRecord.findUnique({ where: { id } });
    if (record === null) return undefined;
    return {
      id: record.id,
      assessmentId: record.assessmentId,
      actor: record.actor,
      nonceHash: record.nonceHash,
      outcome: record.outcome as LiveActivationChallenge['outcome'],
      challengeExpiresAt: record.challengeExpiresAt,
      limits: record.limits as unknown as LiveActivationChallenge['limits'],
      ...(record.consumedAt === null ? {} : { consumedAt: record.consumedAt }),
    };
  }

  public async rejectChallenge(id: string, failureCode: string, at: Date): Promise<void> {
    await this.database.liveActivationRecord.updateMany({
      where: { id, outcome: 'PENDING', consumedAt: null },
      data: { outcome: 'REJECTED', failureCode, consumedAt: at },
    });
  }

  public async activate(
    challengeId: string,
    assessmentId: string,
    actor: string,
    at: Date,
    manualMonitoringUntil: Date,
  ): Promise<boolean> {
    return this.database.$transaction(
      async (transaction) => {
        const latest = await transaction.liveReadinessRecord.findFirst({
          orderBy: { assessedAt: 'desc' },
          select: { id: true },
        });
        if (latest?.id !== assessmentId) return false;
        const consumed = await transaction.liveActivationRecord.updateMany({
          where: {
            id: challengeId,
            assessmentId,
            outcome: 'PENDING',
            consumedAt: null,
            challengeExpiresAt: { gt: at },
          },
          data: {
            outcome: 'ACTIVATED',
            consumedAt: at,
            manualMonitoringUntil,
          },
        });
        if (consumed.count !== 1) return false;
        const activated = await transaction.liveReadinessRecord.updateMany({
          where: { id: assessmentId, state: 'READY_FOR_ACTIVATION', expiresAt: { gt: at } },
          data: { state: 'ACTIVE', activatedAt: at },
        });
        if (activated.count !== 1) throw new Error('Readiness assessment activation conflict');
        const safetyActivated = await transaction.safetyStateRecord.updateMany({
          where: {
            id: 'singleton',
            tradingMode: 'LIVE',
            mode: 'ONLY_CLOSE',
            tradingEnabled: false,
            entriesEnabled: false,
            blocks: { equals: [] },
          },
          data: {
            mode: 'NORMAL',
            tradingEnabled: true,
            entriesEnabled: true,
            exitsAllowed: true,
            lastChangedAt: at,
            version: { increment: 1 },
          },
        });
        if (safetyActivated.count !== 1)
          throw new Error('Safety state is not eligible for LIVE activation');
        await transaction.systemStateRecord.update({
          where: { id: 'singleton' },
          data: {
            state: 'READY',
            reasonCode: 'LIVE_ACTIVATED_EXPLICITLY',
            changedBy: actor,
            version: { increment: 1 },
          },
        });
        await transaction.alertRecord.create({
          data: {
            id: randomUUID(),
            fingerprint: createHash('sha256')
              .update(`LIVE_ACTIVATED:${assessmentId}`)
              .digest('hex'),
            kind: 'LIVE_ACTIVATED',
            severity: 'EMERGENCY',
            state: 'PENDING',
            title: 'LIVE trading activated',
            message: `LIVE was explicitly activated by ${actor}; intensive manual monitoring is mandatory`,
            component: 'live-readiness',
            correlationId: assessmentId,
            metadata: { assessmentId, manualMonitoringUntil: manualMonitoringUntil.toISOString() },
            firstOccurredAt: at,
            lastOccurredAt: at,
            nextDeliveryAt: at,
          },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
  }
}
