import { describe, expect, it } from 'vitest';

import {
  INITIAL_LIVE_LIMITS,
  LIVE_ACTIVATION_PHRASE,
  LIVE_PREPARATION_CONFIRMATION,
  LIVE_READINESS_CONTROLS,
  LiveReadinessService,
  type LiveActivationChallenge,
  type LiveReadinessAssessment,
  type LiveReadinessEvidenceSet,
  type LiveReadinessRepository,
} from './service.js';

class MemoryRepository implements LiveReadinessRepository {
  public assessments: LiveReadinessAssessment[] = [];
  public challenges = new Map<string, LiveActivationChallenge>();

  public async saveAssessment(value: LiveReadinessAssessment): Promise<void> {
    this.assessments.push(value);
  }

  public async latestAssessment(): Promise<LiveReadinessAssessment | undefined> {
    return this.assessments.at(-1);
  }

  public async saveChallenge(value: LiveActivationChallenge): Promise<void> {
    this.challenges.set(value.id, value);
  }

  public async findChallenge(id: string): Promise<LiveActivationChallenge | undefined> {
    return this.challenges.get(id);
  }

  public async rejectChallenge(id: string, _failureCode: string, at: Date): Promise<void> {
    const value = this.challenges.get(id);
    if (value !== undefined)
      this.challenges.set(id, { ...value, outcome: 'REJECTED', consumedAt: at });
  }

  public async activate(
    challengeId: string,
    assessmentId: string,
    _actor: string,
    at: Date,
    _manualMonitoringUntil: Date,
  ): Promise<boolean> {
    const challenge = this.challenges.get(challengeId);
    const assessment = this.assessments.at(-1);
    if (
      challenge?.outcome !== 'PENDING' ||
      assessment?.id !== assessmentId ||
      assessment.state !== 'READY_FOR_ACTIVATION'
    )
      return false;
    this.challenges.set(challengeId, { ...challenge, outcome: 'ACTIVATED', consumedAt: at });
    this.assessments[this.assessments.length - 1] = {
      ...assessment,
      state: 'ACTIVE',
      activatedAt: at,
    };
    return true;
  }
}

const passingEvidence = Object.fromEntries(
  LIVE_READINESS_CONTROLS.map(([, code]) => [code, { passed: true, evidence: `${code} verified` }]),
) as LiveReadinessEvidenceSet;

function readyService(repository: MemoryRepository, now = new Date('2026-08-18T15:00:00Z')) {
  let sequence = 0;
  return new LiveReadinessService(
    repository,
    async () => passingEvidence,
    async () => ({
      environment: 'production',
      tradingMode: 'LIVE',
      brokerConnectivityEnabled: true,
      liveTradingEnabled: true,
      hasLiveCredentials: true,
      brokerAccountIsLive: true,
      accountEquityUsd: INITIAL_LIVE_LIMITS.minimumAccountEquityUsd,
      initialRiskLimitsApplied: true,
      externalSecretsProvider: true,
      mfaConfigured: true,
      externalAlertConfigured: true,
    }),
    () => new Date(now),
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    () => 'a'.repeat(64),
  );
}

describe('LiveReadinessService', () => {
  it('persists NOT_READY and refuses activation when external evidence is absent', async () => {
    const repository = new MemoryRepository();
    const service = new LiveReadinessService(
      repository,
      async () => ({}),
      async () => ({
        environment: 'development',
        tradingMode: 'PAPER',
        brokerConnectivityEnabled: false,
        liveTradingEnabled: false,
        hasLiveCredentials: false,
        brokerAccountIsLive: false,
        accountEquityUsd: 0,
      }),
      () => new Date('2026-08-18T15:00:00Z'),
      () => '00000000-0000-4000-8000-000000000001',
    );
    const result = await service.assess('system');
    expect(result.state).toBe('NOT_READY');
    expect(result.failureCodes).toContain('LIVE_BROKER_ACCOUNT_VERIFIED');
    await expect(
      service.requestActivationChallenge({
        assessmentId: result.id,
        actor: 'operator',
        confirmation: LIVE_PREPARATION_CONFIRMATION,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_NOT_READY' });
  });

  it('requires a two-stage single-use confirmation before atomic LIVE activation', async () => {
    const repository = new MemoryRepository();
    const service = readyService(repository);
    const assessment = await service.assess('operator');
    expect(assessment.state).toBe('READY_FOR_ACTIVATION');
    expect(assessment.limits.maximumOrderNotionalUsd).toBe(100);
    const challenge = await service.requestActivationChallenge({
      assessmentId: assessment.id,
      actor: 'operator',
      confirmation: LIVE_PREPARATION_CONFIRMATION,
    });
    const activated = await service.activate({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      confirmationPhrase: LIVE_ACTIVATION_PHRASE,
      actor: 'operator',
      manualMonitoringAcknowledged: true,
    });
    expect(activated.state).toBe('ACTIVE');
    await expect(
      service.activate({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        confirmationPhrase: LIVE_ACTIVATION_PHRASE,
        actor: 'operator',
        manualMonitoringAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_CHALLENGE_INVALID' });
  });

  it('consumes the challenge after an invalid real-money phrase', async () => {
    const repository = new MemoryRepository();
    const service = readyService(repository);
    const assessment = await service.assess('operator');
    const challenge = await service.requestActivationChallenge({
      assessmentId: assessment.id,
      actor: 'operator',
      confirmation: LIVE_PREPARATION_CONFIRMATION,
    });
    await expect(
      service.activate({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        confirmationPhrase: 'CONFIRMAR',
        actor: 'operator',
        manualMonitoringAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_CONFIRMATION_PHRASE_INVALID' });
    expect(repository.challenges.get(challenge.challengeId)?.outcome).toBe('REJECTED');
  });
});
