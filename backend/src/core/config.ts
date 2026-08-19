import { z } from 'zod';

import { ConfigurationError } from './errors.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

const rawConfigSchema = z
  .object({
    APP_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
    HOST: z
      .string()
      .regex(/^(?:\d{1,3}\.){3}\d{1,3}$|^(?:[\da-f]*:){2,}[\da-f]*$/i, 'HOST must be an IP address')
      .default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_DIRECTORY: z.string().min(1).default('./logs'),
    OPERATOR_TIMEZONE: z.string().min(1).default('America/Argentina/Buenos_Aires'),
    MARKET_TIMEZONE: z.literal('America/New_York').default('America/New_York'),
    BASE_CURRENCY: z.literal('USD').default('USD'),
    MAX_CLOCK_SKEW_MS: z.coerce.number().int().positive().max(10_000).default(1_000),
    DATABASE_URL: z.url().refine((value) => value.startsWith('postgres'), {
      message: 'DATABASE_URL must use PostgreSQL',
    }),
    TRADING_MODE: z.enum(['PAPER', 'LIVE']).default('PAPER'),
    BROKER_CONNECTIVITY_ENABLED: booleanFromString,
    ALPACA_PAPER_BASE_URL: z.url().default('https://paper-api.alpaca.markets'),
    ALPACA_LIVE_BASE_URL: z.url().default('https://api.alpaca.markets'),
    ALPACA_DATA_BASE_URL: z.url().default('https://data.alpaca.markets'),
    ALPACA_DATA_FEED: z.enum(['iex', 'sip']).default('iex'),
    ALPACA_PAPER_API_KEY: optionalSecret,
    ALPACA_PAPER_API_SECRET: optionalSecret,
    ALPACA_LIVE_API_KEY: optionalSecret,
    ALPACA_LIVE_API_SECRET: optionalSecret,
    ENABLE_LIVE_TRADING: booleanFromString,
    LIVE_ACTIVATION_PHRASE: optionalSecret,
    SECRETS_PROVIDER: z
      .enum(['env', 'docker-secrets', 'aws-secrets-manager', 'azure-key-vault', 'vault'])
      .default('env'),
    RELEASE_SHA: z
      .string()
      .regex(/^[a-f0-9]{7,64}$/i)
      .default('0000000'),
    DEPLOYMENT_ID: z.string().min(3).max(128).default('local-development'),
    MARKET_DATA_TIMEFRAME: z.enum(['1Min', '5Min', '15Min']).default('1Min'),
    MARKET_DATA_MAX_AGE_MS: z.coerce.number().int().min(1_000).max(900_000).default(90_000),
    MARKET_DATA_WARMUP_BARS: z.coerce.number().int().min(20).max(2_000).default(60),
    SCANNER_MAX_SYMBOLS: z.coerce.number().int().min(1).max(5_000).default(200),
    SCANNER_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(900_000).default(120_000),
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(60_000),
    RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
    WORKER_DEAD_AFTER_MS: z.coerce.number().int().min(5_000).max(300_000).default(20_000),
    TELEGRAM_BOT_TOKEN: optionalSecret,
    TELEGRAM_CHAT_ID: optionalSecret,
    SMTP_URL: optionalSecret,
    ALERT_EMAIL_TO: optionalSecret,
    OPERATOR_TOTP_SECRET: optionalSecret,
    OPERATOR_USERNAME: z.string().min(3).max(128).default('operator'),
    OPERATOR_PASSWORD_HASH: z.string().min(32),
    SESSION_SIGNING_SECRET: z.string().min(32),
    CSRF_SIGNING_SECRET: z.string().min(32),
    SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(30),
    TRUSTED_ORIGINS: z.string().default('http://127.0.0.1:5173'),
    MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),
  })
  .superRefine((value, context) => {
    const checkZone = (zone: string, path: string): void => {
      try {
        Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
      } catch {
        context.addIssue({
          code: 'custom',
          message: `Invalid IANA timezone: ${zone}`,
          path: [path],
        });
      }
    };
    checkZone(value.OPERATOR_TIMEZONE, 'OPERATOR_TIMEZONE');
    checkZone(value.MARKET_TIMEZONE, 'MARKET_TIMEZONE');

    if (value.BROKER_CONNECTIVITY_ENABLED && value.TRADING_MODE === 'PAPER') {
      if (!value.ALPACA_PAPER_API_KEY || !value.ALPACA_PAPER_API_SECRET) {
        context.addIssue({
          code: 'custom',
          message: 'PAPER credentials are required when broker connectivity is enabled',
          path: ['ALPACA_PAPER_API_KEY'],
        });
      }
    }

    if (value.TRADING_MODE === 'LIVE') {
      if (value.APP_ENV !== 'production') {
        context.addIssue({
          code: 'custom',
          message: 'LIVE mode is only valid in production',
          path: ['TRADING_MODE'],
        });
      }
      if (!value.ENABLE_LIVE_TRADING) {
        context.addIssue({
          code: 'custom',
          message: 'LIVE mode requires ENABLE_LIVE_TRADING=true',
          path: ['ENABLE_LIVE_TRADING'],
        });
      }
      if (!value.BROKER_CONNECTIVITY_ENABLED) {
        context.addIssue({
          code: 'custom',
          message: 'LIVE mode requires BROKER_CONNECTIVITY_ENABLED=true',
          path: ['BROKER_CONNECTIVITY_ENABLED'],
        });
      }
      if (value.LIVE_ACTIVATION_PHRASE !== 'I_UNDERSTAND_REAL_MONEY_IS_AT_RISK') {
        context.addIssue({
          code: 'custom',
          message: 'LIVE activation phrase is absent or invalid',
          path: ['LIVE_ACTIVATION_PHRASE'],
        });
      }
      if (!value.ALPACA_LIVE_API_KEY || !value.ALPACA_LIVE_API_SECRET) {
        context.addIssue({
          code: 'custom',
          message: 'LIVE credentials are required for LIVE mode',
          path: ['ALPACA_LIVE_API_KEY'],
        });
      }
      if (value.SECRETS_PROVIDER === 'env') {
        context.addIssue({
          code: 'custom',
          message:
            'LIVE requires an external secrets provider; plaintext environment files are forbidden',
          path: ['SECRETS_PROVIDER'],
        });
      }
      if (!value.TELEGRAM_BOT_TOKEN || !value.TELEGRAM_CHAT_ID) {
        context.addIssue({
          code: 'custom',
          message: 'LIVE requires a fully configured external Telegram alert channel',
          path: ['TELEGRAM_BOT_TOKEN'],
        });
      }
      if (!value.OPERATOR_TOTP_SECRET || !/^[A-Z2-7]+=*$/i.test(value.OPERATOR_TOTP_SECRET)) {
        context.addIssue({
          code: 'custom',
          message: 'LIVE requires an operator TOTP base32 secret for administrative MFA',
          path: ['OPERATOR_TOTP_SECRET'],
        });
      }
      if (value.ALPACA_DATA_FEED !== 'sip') {
        context.addIssue({
          code: 'custom',
          message: 'LIVE requires the consolidated SIP feed for price and spread decisions',
          path: ['ALPACA_DATA_FEED'],
        });
      }
    }
  });

export interface AppConfig {
  readonly app: {
    readonly environment: 'development' | 'staging' | 'production' | 'test';
    readonly host: string;
    readonly port: number;
    readonly logLevel: string;
    readonly logDirectory: string;
    readonly operatorTimezone: string;
    readonly marketTimezone: 'America/New_York';
    readonly baseCurrency: 'USD';
    readonly maxClockSkewMs: number;
    readonly maxPayloadBytes: number;
  };
  readonly database: { readonly url: string };
  readonly trading: {
    readonly mode: 'PAPER' | 'LIVE';
    readonly brokerConnectivityEnabled: boolean;
    readonly liveTradingEnabled: boolean;
    readonly deploymentId: string;
    readonly releaseSha: string;
    readonly secretsProvider:
      'env' | 'docker-secrets' | 'aws-secrets-manager' | 'azure-key-vault' | 'vault';
  };
  readonly alpaca: {
    readonly paperBaseUrl: string;
    readonly liveBaseUrl: string;
    readonly dataBaseUrl: string;
    readonly dataFeed: 'iex' | 'sip';
    readonly paperKey?: string;
    readonly paperSecret?: string;
    readonly liveKey?: string;
    readonly liveSecret?: string;
  };
  readonly runtime: {
    readonly marketDataTimeframe: '1Min' | '5Min' | '15Min';
    readonly marketDataMaxAgeMs: number;
    readonly marketDataWarmupBars: number;
    readonly scannerMaxSymbols: number;
    readonly scannerTimeoutMs: number;
    readonly schedulerIntervalMs: number;
    readonly reconciliationIntervalMs: number;
    readonly workerHeartbeatIntervalMs: number;
    readonly workerDeadAfterMs: number;
  };
  readonly alerts: {
    readonly telegramBotToken?: string;
    readonly telegramChatId?: string;
    readonly smtpUrl?: string;
    readonly emailTo?: string;
  };
  readonly security: {
    readonly operatorUsername: string;
    readonly operatorPasswordHash: string;
    readonly sessionSigningSecret: string;
    readonly csrfSigningSecret: string;
    readonly sessionTtlMinutes: number;
    readonly trustedOrigins: readonly string[];
    readonly loginMaxAttempts: number;
    readonly loginLockMinutes: number;
    readonly operatorTotpSecret?: string;
  };
}

export function loadConfig(source: NodeJS.ProcessEnv): AppConfig {
  const result = rawConfigSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigurationError('CONFIG_INVALID', 'Application configuration is invalid', details);
  }
  const value = result.data;
  return Object.freeze({
    app: Object.freeze({
      environment: value.APP_ENV,
      host: value.HOST,
      port: value.PORT,
      logLevel: value.LOG_LEVEL,
      logDirectory: value.LOG_DIRECTORY,
      operatorTimezone: value.OPERATOR_TIMEZONE,
      marketTimezone: value.MARKET_TIMEZONE,
      baseCurrency: value.BASE_CURRENCY,
      maxClockSkewMs: value.MAX_CLOCK_SKEW_MS,
      maxPayloadBytes: value.MAX_PAYLOAD_BYTES,
    }),
    database: Object.freeze({ url: value.DATABASE_URL }),
    trading: Object.freeze({
      mode: value.TRADING_MODE,
      brokerConnectivityEnabled: value.BROKER_CONNECTIVITY_ENABLED,
      liveTradingEnabled: value.ENABLE_LIVE_TRADING,
      deploymentId: value.DEPLOYMENT_ID,
      releaseSha: value.RELEASE_SHA,
      secretsProvider: value.SECRETS_PROVIDER,
    }),
    alpaca: Object.freeze({
      paperBaseUrl: value.ALPACA_PAPER_BASE_URL,
      liveBaseUrl: value.ALPACA_LIVE_BASE_URL,
      dataBaseUrl: value.ALPACA_DATA_BASE_URL,
      dataFeed: value.ALPACA_DATA_FEED,
      ...(value.ALPACA_PAPER_API_KEY ? { paperKey: value.ALPACA_PAPER_API_KEY } : {}),
      ...(value.ALPACA_PAPER_API_SECRET ? { paperSecret: value.ALPACA_PAPER_API_SECRET } : {}),
      ...(value.ALPACA_LIVE_API_KEY ? { liveKey: value.ALPACA_LIVE_API_KEY } : {}),
      ...(value.ALPACA_LIVE_API_SECRET ? { liveSecret: value.ALPACA_LIVE_API_SECRET } : {}),
    }),
    runtime: Object.freeze({
      marketDataTimeframe: value.MARKET_DATA_TIMEFRAME,
      marketDataMaxAgeMs: value.MARKET_DATA_MAX_AGE_MS,
      marketDataWarmupBars: value.MARKET_DATA_WARMUP_BARS,
      scannerMaxSymbols: value.SCANNER_MAX_SYMBOLS,
      scannerTimeoutMs: value.SCANNER_TIMEOUT_MS,
      schedulerIntervalMs: value.SCHEDULER_INTERVAL_MS,
      reconciliationIntervalMs: value.RECONCILIATION_INTERVAL_MS,
      workerHeartbeatIntervalMs: value.WORKER_HEARTBEAT_INTERVAL_MS,
      workerDeadAfterMs: value.WORKER_DEAD_AFTER_MS,
    }),
    alerts: Object.freeze({
      ...(value.TELEGRAM_BOT_TOKEN ? { telegramBotToken: value.TELEGRAM_BOT_TOKEN } : {}),
      ...(value.TELEGRAM_CHAT_ID ? { telegramChatId: value.TELEGRAM_CHAT_ID } : {}),
      ...(value.SMTP_URL ? { smtpUrl: value.SMTP_URL } : {}),
      ...(value.ALERT_EMAIL_TO ? { emailTo: value.ALERT_EMAIL_TO } : {}),
    }),
    security: Object.freeze({
      operatorUsername: value.OPERATOR_USERNAME,
      operatorPasswordHash: value.OPERATOR_PASSWORD_HASH,
      sessionSigningSecret: value.SESSION_SIGNING_SECRET,
      csrfSigningSecret: value.CSRF_SIGNING_SECRET,
      sessionTtlMinutes: value.SESSION_TTL_MINUTES,
      trustedOrigins: Object.freeze(
        value.TRUSTED_ORIGINS.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
      loginMaxAttempts: value.LOGIN_MAX_ATTEMPTS,
      loginLockMinutes: value.LOGIN_LOCK_MINUTES,
      ...(value.OPERATOR_TOTP_SECRET === undefined
        ? {}
        : { operatorTotpSecret: value.OPERATOR_TOTP_SECRET }),
    }),
  });
}
