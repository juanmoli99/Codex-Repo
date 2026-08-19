import { describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('opens after threshold and allows one half-open recovery probe', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1_000, () => now);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        breaker.execute(() => Promise.reject(new Error('dependency failure'))),
      ).rejects.toThrow('dependency failure');
    }
    expect(breaker.state()).toBe('OPEN');
    await expect(breaker.execute(() => Promise.resolve('no'))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    now = 1_001;
    await expect(breaker.execute(() => Promise.resolve('recovered'))).resolves.toBe('recovered');
    expect(breaker.state()).toBe('CLOSED');
  });
});
