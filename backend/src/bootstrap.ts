import { loadConfig } from './core/config.js';
import { buildLogger } from './core/logger.js';
import { OperationalStateService } from './core/operational-state.js';
import { createPrismaClient } from './database/client.js';
import { buildServer } from './http/server.js';
import { PrismaLiveReadinessRepository } from './live-readiness/prisma-repository.js';
import {
  collectLiveRuntimeContext,
  collectRuntimeReadinessEvidence,
} from './live-readiness/runtime-evidence.js';
import { LiveReadinessService } from './live-readiness/service.js';
import {
  conservativeLiveRiskConfiguration,
  conservativePaperRiskConfiguration,
  createRiskConfigurationSnapshot,
} from './risk/config.js';
import { AuthService } from './security/auth-service.js';
import { PrismaAuthRepository } from './security/prisma-auth-repository.js';
import { TradingRuntime } from './runtime/trading-runtime.js';

export async function bootstrap(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(environment);
  const logger = buildLogger(config);
  const database = createPrismaClient(config.database.url);
  const operationalState = new OperationalStateService(async (_previous, current) => {
    logger.info({ operationalState: current }, 'Operational state changed');
    await database.systemStateRecord.upsert({
      where: { id: 'singleton' },
      create: {
        state: current.state,
        tradingMode: config.trading.mode,
        reasonCode: current.reasonCode,
        ...(current.reasonDetail ? { reasonDetail: current.reasonDetail } : {}),
        changedBy: current.changedBy,
        version: current.version,
      },
      update: {
        state: current.state,
        reasonCode: current.reasonCode,
        ...(current.reasonDetail ? { reasonDetail: current.reasonDetail } : {}),
        changedBy: current.changedBy,
        version: { increment: 1 },
      },
    });
  });

  try {
    await database.$connect();
    const bootTime = new Date();
    const riskSnapshot = createRiskConfigurationSnapshot(
      config.trading.mode === 'LIVE'
        ? conservativeLiveRiskConfiguration
        : conservativePaperRiskConfiguration,
      bootTime,
    );
    await database.$transaction([
      database.safetyStateRecord.upsert({
        where: { id: 'singleton' },
        create: {
          tradingMode: config.trading.mode,
          mode: 'ONLY_CLOSE',
          tradingEnabled: false,
          entriesEnabled: false,
          exitsAllowed: true,
          blocks: [],
          lastChangedAt: bootTime,
        },
        update: { tradingMode: config.trading.mode },
      }),
      database.riskConfigurationRecord.upsert({
        where: { version: riskSnapshot.configuration.version },
        create: {
          id: riskSnapshot.id,
          version: riskSnapshot.configuration.version,
          checksum: riskSnapshot.checksum,
          configuration: riskSnapshot.configuration,
          active: true,
          activatedAt: bootTime,
        },
        update: { active: true, activatedAt: bootTime },
      }),
      database.riskConfigurationRecord.updateMany({
        where: { version: { not: riskSnapshot.configuration.version }, active: true },
        data: { active: false },
      }),
      database.schedulerConfigurationRecord.upsert({
        where: { id: 'default-paper' },
        create: {
          id: 'default-paper',
          intervalMs: config.runtime.schedulerIntervalMs,
          maximumDriftMs: 5_000,
          lockTtlMs: 120_000,
          enabled: false,
          active: true,
        },
        update: { active: true, intervalMs: config.runtime.schedulerIntervalMs },
      }),
      database.schedulerStateRecord.upsert({
        where: { id: 'singleton' },
        create: {
          state: 'STOPPED',
          configurationId: 'default-paper',
        },
        update: {},
      }),
    ]);
    const authRepository = new PrismaAuthRepository(database);
    await authRepository.ensureSingleOperator(
      config.security.operatorUsername,
      config.security.operatorPasswordHash,
    );
    const authService = new AuthService(
      authRepository,
      config.security.loginMaxAttempts,
      config.security.loginLockMinutes,
      config.security.sessionTtlMinutes,
      config.security.operatorPasswordHash,
    );
    const liveReadiness = new LiveReadinessService(
      new PrismaLiveReadinessRepository(database),
      () => collectRuntimeReadinessEvidence(database),
      () => collectLiveRuntimeContext(database, config),
    );
    const operationsRuntime = await TradingRuntime.create({
      config,
      database,
      logger,
      operationalState,
    });
    await operationsRuntime.start();
    await liveReadiness.assess('system');
    const server = await buildServer({
      config,
      logger,
      database,
      operationalState,
      authService,
      liveReadiness,
      operationsRuntime,
    });
    return {
      config,
      logger,
      database,
      operationalState,
      liveReadiness,
      operationsRuntime,
      server,
    };
  } catch (error) {
    logger.fatal({ err: error }, 'Safe startup failed');
    await database.$disconnect().catch(() => undefined);
    throw error;
  }
}
