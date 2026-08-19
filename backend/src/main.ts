import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootstrap } from './bootstrap.js';
import { resolveSecretFileEnvironment } from './core/secret-files.js';

const rootEnvironmentFile = resolve(import.meta.dirname, '..', '..', '.env');
if (existsSync(rootEnvironmentFile)) {
  if (process.env.APP_ENV === 'production')
    throw new Error(
      'Production refuses local .env files; mount secrets through an external provider',
    );
  process.loadEnvFile(rootEnvironmentFile);
  if (process.env.APP_ENV === 'production')
    throw new Error('Production configuration cannot be loaded from a local .env file');
}

const application = await bootstrap(resolveSecretFileEnvironment(process.env));
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  application.logger.info({ signal }, 'Graceful shutdown started');
  await application.operationalState
    .transition('BLOCKED', 'SHUTDOWN_IN_PROGRESS', 'system')
    .catch((error: unknown) =>
      application.logger.error({ err: error }, 'Failed to persist shutdown state'),
    );
  await application.operationsRuntime
    .shutdown(30_000)
    .catch((error: unknown) =>
      application.logger.error({ err: error }, 'Trading runtime shutdown failed'),
    );
  await application.server.close();
  await application.database.$disconnect();
  application.logger.info('Graceful shutdown completed');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

process.on('uncaughtException', (error) => {
  application.logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException').finally(() => process.exit(1));
});
process.on('unhandledRejection', (error) => {
  application.logger.fatal({ err: error }, 'Unhandled rejection');
  void shutdown('unhandledRejection').finally(() => process.exit(1));
});

await application.server.listen({
  host: application.config.app.host,
  port: application.config.app.port,
});
