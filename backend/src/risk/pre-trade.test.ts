import { describe, expect, it, vi } from 'vitest';
import {
  conservativeLiveRiskConfiguration,
  conservativePaperRiskConfiguration,
  createRiskConfigurationSnapshot,
} from './config.js';
import { PreTradeRiskGate, type PreTradeContext } from './pre-trade.js';
import { sizePosition } from './position-sizing.js';

const snapshot = createRiskConfigurationSnapshot(
  conservativePaperRiskConfiguration,
  new Date('2026-08-18T00:00:00Z'),
);
const sizing = sizePosition(
  {
    symbol: 'AAPL',
    equity: 10_000,
    cash: 5_000,
    buyingPower: 10_000,
    entryPrice: 100,
    stopPrice: 98,
    existingExposure: 0,
    pendingExposure: 0,
    minimumQuantity: 0.001,
    fractionable: true,
    quantityPrecision: 3,
    pricePrecision: 2,
  },
  snapshot,
);

function context(overrides: Partial<PreTradeContext> = {}): PreTradeContext {
  const now = new Date('2026-08-18T14:00:00Z');
  return {
    expectedMode: 'PAPER',
    actualMode: 'PAPER',
    tradingEnabled: true,
    systemReady: true,
    symbolValid: true,
    marketSessionOpen: true,
    marketDataHealth: 'HEALTHY',
    signal: {
      id: 'signal',
      timestamp: now,
      symbol: 'AAPL',
      strategyId: 'trend',
      strategyVersion: '1',
      configurationVersion: '1',
      deploymentId: 'd1',
      type: 'BUY',
      reason: 'test',
      expiresAt: new Date(now.getTime() + 60_000),
      parametersSnapshot: {},
      configurationSnapshot: {},
      deduplicationKey: 'key',
    },
    now,
    positionSizing: sizing,
    equity: 10_000,
    cash: 5_000,
    buyingPower: 10_000,
    currentAssetExposure: 0,
    currentGlobalExposure: 0,
    pendingAssetExposure: 0,
    projectedNotional: sizing.notional,
    currentConcentrationPercent: 0,
    positionCount: 0,
    openOrderCount: 0,
    dailyTradeCount: 0,
    dailyStrategyTradeCount: 0,
    dailyPnl: 0,
    drawdownPercent: 0,
    aggregateRiskPercent: 0,
    averageDailyDollarVolume: 50_000_000,
    spreadBps: 5,
    annualizedVolatility: 0.3,
    quotePrice: 100,
    duplicateOperation: false,
    regulatoryAllowed: true,
    regulatoryReasons: [],
    ...overrides,
  };
}

describe('PreTradeRiskGate', () => {
  it('approves a decision only after all gates pass and persists the snapshot', async () => {
    const save = vi.fn(async () => undefined);
    const gate = new PreTradeRiskGate({ save }, () => 'decision');
    const decision = await gate.evaluate(context(), snapshot);
    expect(decision.outcome).toBe('APPROVED');
    expect(save).toHaveBeenCalledWith(decision);
  });

  it('returns every explicit rejection reason', async () => {
    const gate = new PreTradeRiskGate();
    const decision = await gate.evaluate(
      context({
        tradingEnabled: false,
        actualMode: 'LIVE',
        marketDataHealth: 'STALE',
        duplicateOperation: true,
        regulatoryAllowed: false,
        regulatoryReasons: ['PDT_LIMIT'],
      }),
      snapshot,
    );
    expect(decision.outcome).toBe('REJECTED');
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        'TRADING_DISABLED',
        'TRADING_MODE_MISMATCH',
        'MARKET_DATA_NOT_HEALTHY',
        'DUPLICATE_OPERATION',
        'REGULATORY:PDT_LIMIT',
      ]),
    );
  });

  it('enforces LIVE absolute capital and daily loss caps independently of percentages', async () => {
    const liveSnapshot = createRiskConfigurationSnapshot(
      conservativeLiveRiskConfiguration,
      new Date('2026-08-18T00:00:00Z'),
    );
    const gate = new PreTradeRiskGate();
    const decision = await gate.evaluate(
      context({
        expectedMode: 'LIVE',
        actualMode: 'LIVE',
        equity: 10_000,
        projectedNotional: 101,
        currentGlobalExposure: 450,
        dailyPnl: -26,
      }),
      liveSnapshot,
    );
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        'MAXIMUM_ORDER_NOTIONAL_EXCEEDED',
        'MAXIMUM_TOTAL_CAPITAL_EXCEEDED',
        'ABSOLUTE_DAILY_LOSS_LIMIT_REACHED',
      ]),
    );
  });
});
