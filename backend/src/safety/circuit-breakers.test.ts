import { describe, expect, it } from 'vitest';
import {
  PersistentCircuitBreakerService,
  type CircuitBreakerRepository,
  type CircuitBreakerSnapshot,
} from './circuit-breakers.js';

describe('PersistentCircuitBreakerService', () => {
  it('opens at the threshold and remains fail-closed during half-open probe selection', async () => {
    const values = new Map<string, CircuitBreakerSnapshot>();
    const repository: CircuitBreakerRepository = {
      find: async (key) => values.get(key),
      save: async (value) => void values.set(value.key, value),
      listOpen: async () => [...values.values()].filter((value) => value.state !== 'CLOSED'),
    };
    const service = new PersistentCircuitBreakerService(repository);
    const at = new Date('2026-08-19T14:00:00Z');
    await service.recordFailure({
      scope: 'BROKER',
      reason: 'timeout',
      threshold: 2,
      cooldownMs: 1000,
      at,
    });
    expect(await service.allows('BROKER', undefined, at)).toBe(true);
    await service.recordFailure({
      scope: 'BROKER',
      reason: 'timeout',
      threshold: 2,
      cooldownMs: 1000,
      at,
    });
    expect(await service.allows('BROKER', undefined, at)).toBe(false);
    expect(await service.allows('BROKER', undefined, new Date(at.getTime() + 1001))).toBe(false);
    await service.recordSuccess('BROKER', undefined, new Date(at.getTime() + 1002));
    expect(await service.allows('BROKER')).toBe(true);
  });
});
