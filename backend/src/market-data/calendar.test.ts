import { describe, expect, it, vi } from 'vitest';
import type { AlpacaTradingClient } from '../alpaca/trading-client.js';
import { MarketCalendarService, marketLocalToUtc } from './calendar.js';

describe('MarketCalendarService', () => {
  it('converts New York wall time with DST and honors an early close', async () => {
    expect(marketLocalToUtc('2026-01-05', '09:30').toISOString()).toBe('2026-01-05T14:30:00.000Z');
    expect(marketLocalToUtc('2026-07-06', '09:30').toISOString()).toBe('2026-07-06T13:30:00.000Z');
    const trading = {
      getCalendar: vi.fn(async () => [{ date: '2026-11-27', open: '09:30', close: '13:00' }]),
    } as unknown as AlpacaTradingClient;
    const calendar = new MarketCalendarService(trading);
    await calendar.refresh('2026-11-27', '2026-11-27');
    expect(calendar.sessionAt(new Date('2026-11-27T17:59:00Z'))).toBe('REGULAR');
    expect(calendar.sessionAt(new Date('2026-11-27T18:00:00Z'))).toBe('AFTER_HOURS');
    expect(calendar.isExpectedBarTime(new Date('2026-11-27T14:30:00Z'), '1Min')).toBe(true);
  });
});
