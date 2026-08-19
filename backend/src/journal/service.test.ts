import { describe, expect, it } from 'vitest';
import { TradingJournal, type JournalEvent } from './service.js';

describe('TradingJournal', () => {
  it('builds a correlation-ordered reconstructible timeline', async () => {
    const events: JournalEvent[] = [];
    let id = 0;
    const journal = new TradingJournal(
      {
        append: async (event) => {
          events.push(event);
        },
        timeline: async () => [...events].reverse(),
      },
      () => `event-${(id += 1)}`,
    );
    await journal.record({
      correlationId: 'correlation',
      type: 'SIGNAL',
      occurredAt: new Date('2026-08-18T14:00:00Z'),
      payload: { strategyVersion: '1', reason: 'trend' },
    });
    await journal.record({
      correlationId: 'correlation',
      type: 'RISK_DECISION',
      occurredAt: new Date('2026-08-18T14:00:01Z'),
      payload: { outcome: 'APPROVED' },
    });
    expect((await journal.timeline('correlation')).map((event) => event.sequence)).toEqual([1, 2]);
  });
});
