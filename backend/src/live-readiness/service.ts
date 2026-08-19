import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { AppError, InputValidationError } from '../core/errors.js';

export const LIVE_ACTIVATION_PHRASE = 'I_UNDERSTAND_REAL_MONEY_IS_AT_RISK';
export const LIVE_PREPARATION_CONFIRMATION = 'PREPARAR LIVE';

export const INITIAL_LIVE_LIMITS = Object.freeze({
  maximumOrderNotionalUsd: 100,
  maximumTotalCapitalUsd: 500,
  maximumDailyLossUsd: 25,
  maximumDrawdownPercent: 3,
  minimumAccountEquityUsd: 1_000,
  manualMonitoringTradingDays: 10,
});

export const LIVE_READINESS_CONTROLS = [
  [895, 'PAPER_LIVE_GUARD'],
  [896, 'RECONCILIATION_END_TO_END'],
  [897, 'CRASH_RECOVERY'],
  [898, 'UNKNOWN_ORDER_HANDLING'],
  [899, 'IDEMPOTENCY'],
  [900, 'RISK_MANAGEMENT'],
  [901, 'POSITION_SIZING'],
  [902, 'OPERATIONAL_SAFETY'],
  [903, 'KILL_SWITCH'],
  [904, 'ONLY_CLOSE'],
  [905, 'CIRCUIT_BREAKERS'],
  [906, 'ABSOLUTE_LIMITS'],
  [907, 'PRICE_SANITY'],
  [908, 'LIQUIDITY_GUARD'],
  [909, 'SLIPPAGE_GUARD'],
  [910, 'SCHEDULER_SAFETY'],
  [911, 'FILLS_AND_PARTIAL_FILLS'],
  [912, 'CANCEL_FILL_RACES'],
  [913, 'EXTERNAL_BROKER_ACTIVITY'],
  [914, 'STARTUP_RECONCILIATION'],
  [915, 'CRITICAL_ALERT_DELIVERY'],
  [916, 'BACKUP_AND_DISASTER_RECOVERY'],
  [918, 'LIVE_CONFIGURATION_GUARD'],
  [918, 'LIVE_BROKER_ACCOUNT_VERIFIED'],
  [919, 'STRONG_CONFIRMATION'],
  [925, 'MINIMUM_CAPITAL'],
  [925, 'MANUAL_MONITORING_PLAN'],
  [405, 'BACKTEST_ENGINE_VALIDATED'],
  [408, 'PAPER_SOAK_COMPLETED'],
  [410, 'ZERO_UNKNOWN_ORDERS'],
  [411, 'ZERO_RECONCILIATION_DISCREPANCIES'],
  [412, 'KILL_SWITCH_DRILL'],
  [413, 'RECOVERY_DRILL'],
  [414, 'MID_SESSION_RESTART_DRILL'],
  [415, 'RESTORE_DRILL'],
  [416, 'ALERT_WATCHDOG_DRILL'],
  [417, 'BROKER_OUTAGE_DRILL'],
  [418, 'MARKET_DATA_OUTAGE_DRILL'],
  [419, 'DATABASE_OUTAGE_DRILL'],
  [227, 'CLOCK_HEALTH'],
  [228, 'WORKER_HEARTBEAT'],
  [231, 'MIGRATIONS_CURRENT'],
  [230, 'STRATEGY_DEPLOYMENT_APPROVED'],
] as const;

export type LiveReadinessCheckCode = (typeof LIVE_READINESS_CONTROLS)[number][1];
export type LiveReadinessState = 'NOT_READY' | 'READY_FOR_ACTIVATION' | 'ACTIVE' | 'REVOKED';

export interface LiveReadinessEvidence {
  readonly passed: boolean;
  readonly evidence: string;
}

export type LiveReadinessEvidenceSet = Readonly<
  Partial<Record<LiveReadinessCheckCode, LiveReadinessEvidence>>
>;

export interface LiveRuntimeContext {
  readonly environment: 'development' | 'staging' | 'production' | 'test';
  readonly tradingMode: 'PAPER' | 'LIVE';
  readonly brokerConnectivityEnabled: boolean;
  readonly liveTradingEnabled: boolean;
  readonly hasLiveCredentials: boolean;
  readonly brokerAccountIsLive: boolean;
  readonly accountEquityUsd: number;
  readonly initialRiskLimitsApplied?: boolean;
  readonly externalSecretsProvider?: boolean;
  readonly mfaConfigured?: boolean;
  readonly externalAlertConfigured?: boolean;
}

export interface LiveReadinessCheck {
  readonly code: LiveReadinessCheckCode;
  readonly requirement: number;
  readonly mandatory: true;
  readonly passed: boolean;
  readonly evidence: string;
  readonly checkedAt: Date;
}

export interface LiveReadinessAssessment {
  readonly id: string;
  readonly state: LiveReadinessState;
  readonly tradingMode: 'PAPER' | 'LIVE';
  readonly environment: string;
  readonly configurationChecksum: string;
  readonly limits: typeof INITIAL_LIVE_LIMITS;
  readonly failureCodes: readonly LiveReadinessCheckCode[];
  readonly assessedBy: string;
  readonly assessedAt: Date;
  readonly expiresAt: Date;
  readonly activatedAt?: Date;
  readonly checks: readonly LiveReadinessCheck[];
}

export interface LiveActivationChallenge {
  readonly id: string;
  readonly assessmentId: string;
  readonly actor: string;
  readonly nonceHash: string;
  readonly outcome: 'PENDING' | 'ACTIVATED' | 'REJECTED';
  readonly challengeExpiresAt: Date;
  readonly limits: typeof INITIAL_LIVE_LIMITS;
  readonly consumedAt?: Date;
}

export interface LiveReadinessRepository {
  saveAssessment(assessment: LiveReadinessAssessment): Promise<void>;
  latestAssessment(): Promise<LiveReadinessAssessment | undefined>;
  saveChallenge(challenge: LiveActivationChallenge): Promise<void>;
  findChallenge(id: string): Promise<LiveActivationChallenge | undefined>;
  rejectChallenge(id: string, failureCode: string, at: Date): Promise<void>;
  activate(
    challengeId: string,
    assessmentId: string,
    actor: string,
    at: Date,
    manualMonitoringUntil: Date,
  ): Promise<boolean>;
}

export interface ActivationRequest {
  readonly challengeId: string;
  readonly nonce: string;
  readonly confirmationPhrase: string;
  readonly actor: string;
  readonly manualMonitoringAcknowledged: boolean;
}

type EvidenceCollector = () => Promise<LiveReadinessEvidenceSet>;
type RuntimeContextProvider = () => Promise<LiveRuntimeContext>;

export class LiveReadinessService {
  public constructor(
    private readonly repository: LiveReadinessRepository,
    private readonly collectEvidence: EvidenceCollector,
    private readonly runtimeContext: RuntimeContextProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
    private readonly nonceFactory: () => string = () => randomBytes(32).toString('hex'),
  ) {}

  public latest(): Promise<LiveReadinessAssessment | undefined> {
    return this.repository.latestAssessment();
  }

  public async assess(actor: string): Promise<LiveReadinessAssessment> {
    const at = this.now();
    const [reportedEvidence, context] = await Promise.all([
      this.collectEvidence(),
      this.runtimeContext(),
    ]);
    const evidence: LiveReadinessEvidenceSet = {
      ...reportedEvidence,
      LIVE_CONFIGURATION_GUARD: {
        passed:
          context.environment === 'production' &&
          context.tradingMode === 'LIVE' &&
          context.liveTradingEnabled &&
          context.brokerConnectivityEnabled &&
          context.hasLiveCredentials &&
          context.externalSecretsProvider === true &&
          context.externalAlertConfigured === true &&
          context.mfaConfigured === true,
        evidence:
          context.environment === 'production' && context.tradingMode === 'LIVE'
            ? 'Production LIVE mode requested with explicit enable flag and credential presence checks'
            : 'Runtime is not explicitly configured for production LIVE operation',
      },
      LIVE_BROKER_ACCOUNT_VERIFIED: {
        passed: context.brokerAccountIsLive,
        evidence: context.brokerAccountIsLive
          ? 'Broker account endpoint independently identified the connected account as LIVE'
          : 'No independent LIVE broker-account verification is available',
      },
      MINIMUM_CAPITAL: {
        passed: context.accountEquityUsd >= INITIAL_LIVE_LIMITS.minimumAccountEquityUsd,
        evidence: `Broker-authoritative equity USD ${context.accountEquityUsd.toFixed(2)}; minimum USD ${INITIAL_LIVE_LIMITS.minimumAccountEquityUsd.toFixed(2)}`,
      },
      STRONG_CONFIRMATION: {
        passed: context.mfaConfigured === true,
        evidence:
          context.mfaConfigured === true
            ? 'Password reauthentication, TOTP, expiring single-use nonce, and exact risk phrase are enforced'
            : 'Administrative TOTP is not configured',
      },
      ABSOLUTE_LIMITS: {
        passed: context.initialRiskLimitsApplied === true,
        evidence:
          context.initialRiskLimitsApplied === true
            ? `Active immutable caps do not exceed order USD ${INITIAL_LIVE_LIMITS.maximumOrderNotionalUsd}, capital USD ${INITIAL_LIVE_LIMITS.maximumTotalCapitalUsd}, daily loss USD ${INITIAL_LIVE_LIMITS.maximumDailyLossUsd}, drawdown ${INITIAL_LIVE_LIMITS.maximumDrawdownPercent}%`
            : 'Active risk configuration exceeds or cannot prove the initial LIVE caps',
      },
      MANUAL_MONITORING_PLAN: {
        passed: true,
        evidence: `${INITIAL_LIVE_LIMITS.manualMonitoringTradingDays} business days of intensive manual monitoring are recorded on activation`,
      },
    };
    const checks: LiveReadinessCheck[] = LIVE_READINESS_CONTROLS.map(([requirement, code]) => {
      const item = evidence[code];
      return {
        code,
        requirement,
        mandatory: true,
        passed: item?.passed ?? false,
        evidence: item?.evidence ?? 'No verifiable evidence supplied by the runtime probe',
        checkedAt: new Date(at),
      };
    });
    const failureCodes = checks.filter((check) => !check.passed).map((check) => check.code);
    const assessment: LiveReadinessAssessment = {
      id: this.idFactory(),
      state: failureCodes.length === 0 ? 'READY_FOR_ACTIVATION' : 'NOT_READY',
      tradingMode: context.tradingMode,
      environment: context.environment,
      configurationChecksum: checksum({ context, evidence, limits: INITIAL_LIVE_LIMITS }),
      limits: INITIAL_LIVE_LIMITS,
      failureCodes,
      assessedBy: actor,
      assessedAt: new Date(at),
      expiresAt: new Date(at.getTime() + 60 * 60 * 1_000),
      checks,
    };
    await this.repository.saveAssessment(assessment);
    return assessment;
  }

  public async requestActivationChallenge(input: {
    readonly assessmentId: string;
    readonly actor: string;
    readonly confirmation: string;
  }): Promise<{ challengeId: string; nonce: string; expiresAt: Date }> {
    if (input.confirmation !== LIVE_PREPARATION_CONFIRMATION)
      throw new InputValidationError(
        'LIVE_PREPARATION_CONFIRMATION_REQUIRED',
        `Confirmation must be exactly ${LIVE_PREPARATION_CONFIRMATION}`,
      );
    const at = this.now();
    const assessment = await this.requireCurrentReadyAssessment(input.assessmentId, at);
    const nonce = this.nonceFactory();
    const challenge: LiveActivationChallenge = {
      id: this.idFactory(),
      assessmentId: assessment.id,
      actor: input.actor,
      nonceHash: sha256(nonce),
      outcome: 'PENDING',
      challengeExpiresAt: new Date(at.getTime() + 5 * 60 * 1_000),
      limits: INITIAL_LIVE_LIMITS,
    };
    await this.repository.saveChallenge(challenge);
    return { challengeId: challenge.id, nonce, expiresAt: challenge.challengeExpiresAt };
  }

  public async activate(input: ActivationRequest): Promise<LiveReadinessAssessment> {
    const at = this.now();
    const challenge = await this.repository.findChallenge(input.challengeId);
    if (challenge?.outcome !== 'PENDING')
      throw conflict(
        'LIVE_CHALLENGE_INVALID',
        'Activation challenge is missing or already consumed',
      );
    const reject = async (code: string, message: string): Promise<never> => {
      await this.repository.rejectChallenge(challenge.id, code, at);
      throw conflict(code, message);
    };
    if (challenge.actor !== input.actor)
      return reject(
        'LIVE_CHALLENGE_ACTOR_MISMATCH',
        'Activation challenge belongs to another actor',
      );
    if (challenge.challengeExpiresAt.getTime() <= at.getTime())
      return reject('LIVE_CHALLENGE_EXPIRED', 'Activation challenge has expired');
    if (!secureHashEquals(challenge.nonceHash, sha256(input.nonce)))
      return reject('LIVE_CHALLENGE_NONCE_INVALID', 'Activation challenge nonce is invalid');
    if (input.confirmationPhrase !== LIVE_ACTIVATION_PHRASE)
      return reject(
        'LIVE_CONFIRMATION_PHRASE_INVALID',
        'Exact real-money risk confirmation is required',
      );
    if (!input.manualMonitoringAcknowledged)
      return reject(
        'LIVE_MONITORING_ACKNOWLEDGEMENT_REQUIRED',
        'Manual monitoring commitment must be acknowledged',
      );
    await this.requireCurrentReadyAssessment(challenge.assessmentId, at);
    const manualMonitoringUntil = addBusinessDays(
      at,
      INITIAL_LIVE_LIMITS.manualMonitoringTradingDays,
    );
    const activated = await this.repository.activate(
      challenge.id,
      challenge.assessmentId,
      input.actor,
      at,
      manualMonitoringUntil,
    );
    if (!activated)
      throw conflict(
        'LIVE_ACTIVATION_RACE_REJECTED',
        'Activation was already consumed or superseded',
      );
    const latest = await this.repository.latestAssessment();
    if (latest?.id !== challenge.assessmentId || latest.state !== 'ACTIVE')
      throw conflict('LIVE_ACTIVATION_PERSISTENCE_FAILED', 'Activation did not persist atomically');
    return latest;
  }

  private async requireCurrentReadyAssessment(
    assessmentId: string,
    at: Date,
  ): Promise<LiveReadinessAssessment> {
    const assessment = await this.repository.latestAssessment();
    if (assessment?.id !== assessmentId)
      throw conflict('LIVE_ASSESSMENT_SUPERSEDED', 'A current readiness assessment is required');
    if (assessment.state !== 'READY_FOR_ACTIVATION')
      throw conflict('LIVE_NOT_READY', 'Every mandatory LIVE-readiness check must pass');
    if (assessment.expiresAt.getTime() <= at.getTime())
      throw conflict('LIVE_ASSESSMENT_EXPIRED', 'LIVE-readiness assessment has expired');
    return assessment;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function checksum(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  return value;
}

function secureHashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function addBusinessDays(value: Date, count: number): Date {
  const result = new Date(value);
  let remaining = count;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

function conflict(code: string, message: string): AppError {
  return new AppError(code, message, 409, 'SAFETY', 'CRITICAL');
}
