import { describe, expect, it } from 'vitest';

import { TradingHaltService } from './halts.js';

describe('TradingHaltService', () => {
  it('invalidates state on halt and requires cooldown plus revalidation after resume', () => {
    let now = Date.parse('2026-08-18T14:00:00Z');
    const service = new TradingHaltService(60_000, () => now);
    service.initializeTrading('SPY');
    const haltTime = new Date(now);
    const halted = service.applyStatus({
      type: 'STATUS',
      symbol: 'SPY',
      statusCode: 'H',
      statusMessage: 'Trading Halt',
      reasonCode: 'LUDP',
      reasonMessage: 'Volatility Trading Pause',
      timestamp: haltTime,
    });
    expect(halted.snapshot.state).toBe('HALTED');
    expect(halted.plan.invalidateCachedPrices).toBe(true);
    expect(service.canOpen('SPY')).toBe(false);

    service.applyStatus({
      type: 'STATUS',
      symbol: 'SPY',
      statusCode: 'T',
      statusMessage: 'Trading Resumption',
      reasonCode: 'R',
      reasonMessage: 'Issue Available',
      timestamp: new Date(now + 1_000),
    });
    now += 60_999;
    expect(service.confirmRevalidation('SPY')?.state).toBe('RESUME_COOLDOWN');
    now += 2;
    expect(service.confirmRevalidation('SPY')?.state).toBe('TRADING');
  });
});
