import { describe, expect, it } from 'vitest';

import { ConfigurationError } from './errors.js';
import { loadConfig } from './config.js';

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://aegis:test@127.0.0.1:5432/aegis',
    OPERATOR_PASSWORD_HASH: 'x'.repeat(64),
    SESSION_SIGNING_SECRET: 's'.repeat(32),
    CSRF_SIGNING_SECRET: 'c'.repeat(32),
  };
}

describe('loadConfig', () => {
  it('defaults to PAPER with broker connectivity disabled', () => {
    const config = loadConfig(baseEnvironment());
    expect(config.trading).toEqual({
      mode: 'PAPER',
      brokerConnectivityEnabled: false,
      liveTradingEnabled: false,
      deploymentId: 'local-development',
      releaseSha: '0000000',
      secretsProvider: 'env',
    });
    expect(config.app.marketTimezone).toBe('America/New_York');
  });

  it('fails fast when broker connectivity has no PAPER credentials', () => {
    expect(() => loadConfig({ ...baseEnvironment(), BROKER_CONNECTIVITY_ENABLED: 'true' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects every incomplete LIVE activation', () => {
    const attempts: NodeJS.ProcessEnv[] = [
      { ...baseEnvironment(), TRADING_MODE: 'LIVE' },
      { ...baseEnvironment(), APP_ENV: 'production', TRADING_MODE: 'LIVE' },
      {
        ...baseEnvironment(),
        APP_ENV: 'production',
        TRADING_MODE: 'LIVE',
        ENABLE_LIVE_TRADING: 'true',
        LIVE_ACTIVATION_PHRASE: 'wrong',
      },
    ];
    for (const attempt of attempts) expect(() => loadConfig(attempt)).toThrow(ConfigurationError);
  });

  it('keeps PAPER and LIVE broker credentials strictly separated', () => {
    const config = loadConfig({
      ...baseEnvironment(),
      APP_ENV: 'production',
      TRADING_MODE: 'LIVE',
      BROKER_CONNECTIVITY_ENABLED: 'true',
      ENABLE_LIVE_TRADING: 'true',
      LIVE_ACTIVATION_PHRASE: 'I_UNDERSTAND_REAL_MONEY_IS_AT_RISK',
      ALPACA_LIVE_API_KEY: 'live-key',
      ALPACA_LIVE_API_SECRET: 'live-secret',
      ALPACA_PAPER_API_KEY: 'paper-key',
      ALPACA_PAPER_API_SECRET: 'paper-secret',
      SECRETS_PROVIDER: 'vault',
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: '123456',
      OPERATOR_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      ALPACA_DATA_FEED: 'sip',
    });
    expect(config.trading.mode).toBe('LIVE');
    expect(config.alpaca.liveKey).toBe('live-key');
    expect(config.alpaca.paperKey).toBe('paper-key');
  });
});
