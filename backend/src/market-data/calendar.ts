import type { AlpacaCalendarDay, AlpacaClock } from '../alpaca/types.js';
import type { AlpacaTradingClient } from '../alpaca/trading-client.js';
import type { Timeframe } from './types.js';
import { timeframeMilliseconds } from './types.js';

export type MarketSession = 'PREMARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED' | 'UNKNOWN';

export interface SessionWindow {
  readonly date: string;
  readonly regularOpen: Date;
  readonly regularClose: Date;
  readonly extendedOpen: Date;
  readonly extendedClose: Date;
}

function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return represented - instant.getTime();
}

export function marketLocalToUtc(date: string, time: string, timeZone = 'America/New_York'): Date {
  const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = date.split('-').map(Number);
  const [hour = Number.NaN, minute = Number.NaN] = time.split(':').map(Number);
  if ([year, month, day, hour, minute].some((value) => !Number.isInteger(value)))
    throw new Error(`Invalid market calendar value ${date} ${time}`);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0);
  let result = new Date(wallClock);
  for (let index = 0; index < 2; index += 1)
    result = new Date(wallClock - offsetAt(result, timeZone));
  return result;
}

function windowFor(day: AlpacaCalendarDay): SessionWindow {
  return {
    date: day.date,
    regularOpen: marketLocalToUtc(day.date, day.open),
    regularClose: marketLocalToUtc(day.date, day.close),
    extendedOpen: marketLocalToUtc(day.date, day.session_open ?? '04:00'),
    extendedClose: marketLocalToUtc(day.date, day.session_close ?? '20:00'),
  };
}

function dateInMarketZone(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export class MarketCalendarService {
  private readonly sessions = new Map<string, SessionWindow>();

  public constructor(private readonly trading: AlpacaTradingClient) {}

  public async refresh(start: string, end: string): Promise<void> {
    const calendar = await this.trading.getCalendar(start, end);
    for (const day of calendar) this.sessions.set(day.date, windowFor(day));
  }

  public async clock(): Promise<AlpacaClock> {
    return this.trading.getClock();
  }

  public sessionAt(instant: Date): MarketSession {
    const window = this.sessions.get(dateInMarketZone(instant));
    if (!window) return 'CLOSED';
    const timestamp = instant.getTime();
    if (timestamp >= window.regularOpen.getTime() && timestamp < window.regularClose.getTime())
      return 'REGULAR';
    if (timestamp >= window.extendedOpen.getTime() && timestamp < window.regularOpen.getTime())
      return 'PREMARKET';
    if (timestamp >= window.regularClose.getTime() && timestamp < window.extendedClose.getTime())
      return 'AFTER_HOURS';
    return 'CLOSED';
  }

  public isExpectedBarTime(instant: Date, timeframe: Timeframe, regularOnly = true): boolean {
    const window = this.sessions.get(dateInMarketZone(instant));
    if (!window) return false;
    const start = regularOnly ? window.regularOpen : window.extendedOpen;
    const end = regularOnly ? window.regularClose : window.extendedClose;
    const timestamp = instant.getTime();
    return (
      timestamp >= start.getTime() &&
      timestamp < end.getTime() &&
      (timestamp - start.getTime()) % timeframeMilliseconds(timeframe) === 0
    );
  }

  public regularWindow(instant: Date): SessionWindow | undefined {
    return this.sessions.get(dateInMarketZone(instant));
  }
}
