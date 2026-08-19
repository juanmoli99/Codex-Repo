import { describe, expect, it } from 'vitest';

import { InMemoryMarketEventProvider, MarketEventService } from './service.js';

describe('MarketEventService', () => {
  it('applies an earnings blackout and size reduction', async () => {
    const earnings = {
      id: 'earnings-1',
      symbol: 'AAPL',
      type: 'EARNINGS' as const,
      scheduledAt: new Date('2026-08-19T20:05:00Z'),
      timing: 'POST_MARKET' as const,
      source: 'test',
      sourceVersion: '1',
    };
    const service = new MarketEventService(new InMemoryMarketEventProvider([earnings]));
    await service.refresh(
      ['AAPL'],
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
    const result = service.evaluate(
      'AAPL',
      {
        id: 'earnings-blackout-v1',
        strategyId: 'trend',
        eventType: 'EARNINGS',
        blackoutBeforeMs: 86_400_000,
        blackoutAfterMs: 43_200_000,
        positionSizeMultiplier: 0,
        prohibitOvernight: true,
        failClosedWhenCalendarUnavailable: true,
      },
      new Date('2026-08-19T12:00:00Z'),
    );
    expect(result.entryAllowed).toBe(false);
    expect(result.overnightAllowed).toBe(false);
    expect(result.reasons).toContain('EVENT_BLACKOUT_ACTIVE');
  });
});
