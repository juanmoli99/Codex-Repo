import { describe, expect, it } from 'vitest';

import { validateBacktestStudy, type BacktestStudyRun } from './study.js';

describe('validateBacktestStudy', () => {
  it('requires walk-forward, OOS, sensitivity, stress, diversity, capacity, benchmark and sample evidence', () => {
    const runs: BacktestStudyRun[] = [];
    const symbols = ['AAPL', 'MSFT', 'SPY'] as const;
    const costs = [2, 8, 15] as const;
    const regimes = ['TRENDING', 'RANGING', 'VOLATILE'] as const;
    for (let index = 0; index < 18; index += 1) {
      const symbol = symbols.at(index % symbols.length);
      const costBps = costs.at(index % costs.length);
      const regime = regimes.at(index % regimes.length);
      if (symbol === undefined || costBps === undefined || regime === undefined)
        throw new Error('Study fixture lookup failed');
      runs.push({
        id: `run-${index.toString().padStart(2, '0')}`,
        fold: `fold-${index % 3}`,
        segment: index < 3 ? 'IN_SAMPLE' : 'OUT_OF_SAMPLE',
        symbol,
        periodStart: index % 2 === 0 ? '2024-01-01' : '2025-01-01',
        periodEnd: index % 2 === 0 ? '2024-06-30' : '2025-06-30',
        parameterSet: `p-${index % 3}`,
        costBps,
        regime,
        tradeCount: 10,
        netProfit: 100 + index,
        alphaPercent: 1,
        turnover: 2,
        capacityConstrainedTrades: 0,
      });
    }
    const report = validateBacktestStudy(runs);
    expect(report.accepted).toBe(true);
    expect(report.checks.minimumSample).toMatchObject({ passed: true });
    expect(report.bootstrapNetProfit?.p05).toBeGreaterThan(0);
  });

  it('never accepts a favorable but undersampled single backtest', () => {
    const report = validateBacktestStudy([
      {
        id: 'one',
        fold: 'one',
        segment: 'OUT_OF_SAMPLE',
        symbol: 'AAPL',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        parameterSet: 'best',
        costBps: 2,
        regime: 'TRENDING',
        tradeCount: 5,
        netProfit: 10_000,
        alphaPercent: 100,
        turnover: 1,
        capacityConstrainedTrades: 0,
      },
    ]);
    expect(report.accepted).toBe(false);
    expect(report.checks.minimumSample.passed).toBe(false);
  });
});
