import type { FastifyBaseLogger } from 'fastify';

import type { AppConfig } from '../core/config.js';
import type { OperationalStateService } from '../core/operational-state.js';
import type { DatabaseClient } from '../database/client.js';
import type { LiveReadinessService } from '../live-readiness/service.js';
import type { AuthService } from '../security/auth-service.js';
import type { OperationsRuntime } from '../runtime/types.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly logger: FastifyBaseLogger;
  readonly database: DatabaseClient;
  readonly operationalState: OperationalStateService;
  readonly authService: AuthService;
  readonly liveReadiness?: LiveReadinessService;
  readonly operationsRuntime: OperationsRuntime;
}
