import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { ConfigurationError } from './errors.js';

const FILE_BACKED_SECRETS = [
  'DATABASE_URL',
  'ALPACA_PAPER_API_KEY',
  'ALPACA_PAPER_API_SECRET',
  'ALPACA_LIVE_API_KEY',
  'ALPACA_LIVE_API_SECRET',
  'OPERATOR_PASSWORD_HASH',
  'SESSION_SIGNING_SECRET',
  'CSRF_SIGNING_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'OPERATOR_TOTP_SECRET',
] as const;

/** Resolve Docker/Kubernetes-style secret mounts without ever logging their contents. */
export function resolveSecretFileEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...source };
  const mode = source.TRADING_MODE === 'LIVE' ? 'LIVE' : 'PAPER';
  const genericAlpacaSecrets = [
    ['ALPACA_API_KEY_FILE', `ALPACA_${mode}_API_KEY`],
    ['ALPACA_API_SECRET_FILE', `ALPACA_${mode}_API_SECRET`],
  ] as const;
  for (const [fileVariable, target] of genericAlpacaSecrets) {
    const path = source[fileVariable];
    if (!path) continue;
    if (source[target] || source[`${target}_FILE`])
      throw new ConfigurationError(
        'SECRET_SOURCE_AMBIGUOUS',
        `${fileVariable} conflicts with the mode-specific ${target} secret`,
        [],
      );
    resolved[`${target}_FILE`] = path;
  }
  for (const name of FILE_BACKED_SECRETS) {
    const path = resolved[`${name}_FILE`];
    if (!path) continue;
    if (resolved[name])
      throw new ConfigurationError(
        'SECRET_SOURCE_AMBIGUOUS',
        `${name} and ${name}_FILE cannot both be configured`,
        [],
      );
    if (!isAbsolute(path))
      throw new ConfigurationError(
        'SECRET_PATH_INVALID',
        `${name}_FILE must be an absolute path`,
        [],
      );
    let value: string;
    try {
      value = readFileSync(path, { encoding: 'utf8' }).trim();
    } catch (error) {
      throw new ConfigurationError('SECRET_FILE_UNREADABLE', `${name}_FILE cannot be read`, [
        error instanceof Error ? error.message : 'Unknown filesystem error',
      ]);
    }
    if (!value)
      throw new ConfigurationError(
        'SECRET_FILE_EMPTY',
        `${name}_FILE resolved to an empty value`,
        [],
      );
    resolved[name] = value;
  }
  return resolved;
}
