import { describe, expect, it } from 'vitest';
import { aggregateExecutionQuality, measureExecutionQuality } from './execution-quality.js';
import { calculatePnl, enforceRuntimeRisk } from './pnl.js';

describe('P&L and execution quality', () => {
  it('builds the equity curve and enforces runtime drawdown', () => {
    const summary = calculatePnl({
      initialEquity: 10_000,
      currentUnrealizedPnl: -50,
      now: new Date('2026-08-18T20:00:00Z'),
      trades: [
        {
          id: 't1',
          symbol: 'AAPL',
          strategyId: 'trend',
          openedAt: new Date('2026-08-17T14:00:00Z'),
          closedAt: new Date('2026-08-18T15:00:00Z'),
          realizedPnl: 200,
        },
        {
          id: 't2',
          symbol: 'MSFT',
          strategyId: 'mean',
          openedAt: new Date('2026-08-18T15:00:00Z'),
          closedAt: new Date('2026-08-18T16:00:00Z'),
          realizedPnl: -500,
        },
      ],
    });
    expect(summary.realized.toFixed()).toBe('-300');
    expect(summary.maximumDrawdownPercent.toNumber()).toBeCloseTo(4.902, 3);
    expect(
      enforceRuntimeRisk({
        dailyPnl: -300,
        equity: 10_000,
        drawdownPercent: 9,
        portfolioRiskPercent: 2,
        dailyLossLimitPercent: 2,
        maximumDrawdownPercent: 8,
        maximumPortfolioRiskPercent: 3,
      }).type,
    ).toBe('KILL_SWITCH');
  });

  it('measures adverse buy slippage and detects rolling degradation', () => {
    const sample = {
      id: 'quality',
      symbol: 'AAPL',
      strategyId: 'trend',
      orderType: 'market',
      side: 'buy' as const,
      quantity: 8,
      requestedQuantity: 10,
      decisionPrice: 100,
      signalPrice: 100,
      submissionPrice: 100,
      arrivalPrice: 100,
      expectedFillPrice: 100,
      fillPrice: 100.5,
      spreadBps: 5,
      volatility: 0.3,
      signaledAt: new Date('2026-08-18T14:00:00.000Z'),
      submittedAt: new Date('2026-08-18T14:00:00.100Z'),
      acceptedAt: new Date('2026-08-18T14:00:00.150Z'),
      filledAt: new Date('2026-08-18T14:00:00.300Z'),
      rejected: false,
      canceled: false,
      partialFill: true,
    };
    expect(measureExecutionQuality(sample).slippageBps?.toFixed()).toBe('50');
    expect(aggregateExecutionQuality([sample], 25)).toMatchObject({
      sampleCount: 1,
      degraded: true,
    });
  });
});
