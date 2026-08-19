import { describe, expect, it } from 'vitest';

import { redactSecrets } from './redaction.js';

describe('redactSecrets', () => {
  it('redacts nested secrets without changing safe values', () => {
    const result = redactSecrets({
      symbol: 'SPY',
      credentials: { apiKey: 'key', api_secret: 'secret' },
      headers: { authorization: 'Bearer token' },
    });
    expect(result).toEqual({
      symbol: 'SPY',
      credentials: { apiKey: '[REDACTED]', api_secret: '[REDACTED]' },
      headers: { authorization: '[REDACTED]' },
    });
  });
});
