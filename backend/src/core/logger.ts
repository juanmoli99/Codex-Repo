import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import pino, { type Logger } from 'pino';

import type { AppConfig } from './config.js';
import { redactSecrets } from './redaction.js';

export function buildLogger(config: AppConfig): Logger {
  mkdirSync(config.app.logDirectory, { recursive: true });
  const fileDestination = pino.destination({
    dest: join(config.app.logDirectory, 'aegis.ndjson'),
    mkdir: true,
    sync: false,
  });
  const streams: pino.StreamEntry[] = [{ stream: fileDestination }];
  if (config.app.environment !== 'test') streams.push({ stream: process.stdout });

  return pino(
    {
      level: config.app.logLevel,
      base: { service: 'aegis-backend', environment: config.app.environment },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.secret',
          '*.token',
          '*.apiKey',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        err: pino.stdSerializers.err,
        body: redactSecrets,
      },
    },
    pino.multistream(streams),
  );
}
