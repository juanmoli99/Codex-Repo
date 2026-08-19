import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { alpacaOrderSchema } from '../alpaca/types.js';
import { AlpacaUnknownOutcomeError } from '../alpaca/http-client.js';
import type { OrderTransition } from './order-state-machine.js';
import {
  createRiskConfigurationSnapshot,
  conservativePaperRiskConfiguration,
} from '../risk/config.js';
import { sizePosition } from '../risk/position-sizing.js';
import { OperationalSafetyService } from '../safety/service.js';
import {
  buildOrderRequest,
  TradeExecutor,
  type TradeExecutorDependencies,
  type TradeExecutionRepository,
  type TradeIntent,
} from './trade-executor.js';

const now = new Date('2026-08-18T14:00:00Z');
const riskSnapshot = createRiskConfigurationSnapshot(conservativePaperRiskConfiguration, now);
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
  riskSnapshot,
);

function intent(): TradeIntent {
  return {
    id: 'intent-00000000-0000-0000-0000-000000000001',
    deduplicationKey: 'signal:entry',
    signal: {
      id: 'signal-00000000-0000-0000-0000-000000000001',
      timestamp: now,
      symbol: 'AAPL',
      strategyId: 'trend',
      strategyVersion: '1',
      configurationVersion: '1',
      deploymentId: 'd1',
      type: 'BUY',
      reason: 'trend',
      expiresAt: new Date(now.getTime() + 60_000),
      parametersSnapshot: {},
      configurationSnapshot: {},
      deduplicationKey: 'signal-key',
    },
    specification: {
      side: 'buy',
      type: 'market',
      timeInForce: 'day',
      orderClass: 'simple',
      extendedHours: false,
      pricePrecision: 2,
      maximumPriceDeviationBps: 100,
    },
    createdAt: now,
    correlationId: 'correlation',
    immutableConfigurationSnapshot: {},
  };
}

async function setup(
  submitOrder: () => Promise<ReturnType<typeof alpacaOrderSchema.parse>>,
  overrides: Partial<TradeExecutorDependencies> = {},
) {
  const results = new Map<string, Awaited<ReturnType<TradeExecutor['execute']>>>();
  const saveOrder = vi.fn(async () => undefined);
  const appendTransition = vi.fn(
    async (_orderId: string, _transition: OrderTransition): Promise<void> => undefined,
  );
  const repository: TradeExecutionRepository = {
    executeWithIntentLock: async (_intent, operation) => operation(),
    hasActiveProtection: async () => false,
    findByDeduplicationKey: async (key) => results.get(key),
    saveIntent: vi.fn(async () => undefined),
    saveOrder,
    appendTransition,
    saveBrokerResponse: vi.fn(async () => undefined),
    updateIntentState: vi.fn(async () => undefined),
    saveResult: async (key, result) => {
      results.set(key, result);
    },
  };
  const safety = new OperationalSafetyService('PAPER');
  await safety.activate({ actor: 'test', reason: 'test', at: now });
  const reconcile = vi.fn(async () => undefined);
  const executor = new TradeExecutor({
    repository,
    safety,
    tradingMode: 'PAPER',
    submitOrder,
    finalValidate: async () => [],
    finalRiskGate: async () => ({
      id: 'risk',
      outcome: 'APPROVED',
      signalId: 'signal',
      symbol: 'AAPL',
      evaluatedAt: now,
      reasonCodes: [],
      configurationSnapshotId: riskSnapshot.id,
      decisionSnapshot: {},
    }),
    recalculateSizing: async () => sizing,
    getReferencePrice: async () => new Decimal(100),
    requestReconciliation: reconcile,
    now: () => now,
    idFactory: () => 'order-00000000-0000-0000-0000-000000000001',
    ...overrides,
  });
  return { executor, repository, reconcile, saveOrder, appendTransition, safety };
}

describe('TradeExecutor', () => {
  it('persists before submit and deduplicates a completed intent', async () => {
    const broker = alpacaOrderSchema.parse({
      id: 'broker',
      client_order_id: 'broker-client',
      created_at: '2026-08-18T14:00:00Z',
      updated_at: '2026-08-18T14:00:00Z',
      asset_id: 'asset',
      symbol: 'AAPL',
      asset_class: 'us_equity',
      qty: '10',
      filled_qty: '0',
      order_class: 'simple',
      order_type: 'market',
      type: 'market',
      side: 'buy',
      time_in_force: 'day',
      status: 'new',
      extended_hours: false,
    });
    const submit = vi.fn(async () => broker);
    const { executor, saveOrder } = await setup(submit);
    const first = await executor.execute(intent());
    const second = await executor.execute(intent());
    expect(first).toBe(second);
    expect(first.order?.state).toBe('ACCEPTED');
    expect(submit).toHaveBeenCalledOnce();
    expect(saveOrder).toHaveBeenCalledBefore(submit);
  });

  it('marks a lost submit response UNKNOWN and requests reconciliation without retry', async () => {
    const submit = vi.fn(async () => {
      throw new AlpacaUnknownOutcomeError('client');
    });
    const { executor, reconcile } = await setup(submit);
    const result = await executor.execute(intent());
    expect(result).toMatchObject({ intentState: 'UNKNOWN', reconciliationRequired: true });
    expect(result.order?.state).toBe('UNKNOWN');
    expect(submit).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('rejects the order if a kill switch races with the final submit boundary', async () => {
    const submit = vi.fn(async () => {
      throw new Error('submit must not be reached');
    });
    const { executor, appendTransition, safety } = await setup(submit);
    appendTransition.mockImplementation(async (_orderId, transition) => {
      if (transition.to === 'SUBMITTING')
        await safety.killSwitch('test', 'concurrent emergency', now);
    });

    const result = await executor.execute(intent());

    expect(result).toMatchObject({
      intentState: 'REJECTED',
      reasons: ['SAFETY_CHANGED_BEFORE_SUBMIT'],
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('persists all supported broker request price and protection fields with explicit rounding', () => {
    const candidate = intent();
    const request = buildOrderRequest(
      {
        ...candidate,
        specification: {
          ...candidate.specification,
          type: 'stop_limit',
          orderClass: 'bracket',
          limitPrice: '100.126',
          stopPrice: '99.994',
          trailPrice: '1.236',
          trailPercent: '1.5',
          takeProfitPrice: '110.129',
          stopLossPrice: '95.124',
          stopLossLimitPrice: '94.116',
        },
      },
      sizing,
      'client',
    );
    expect(request).toMatchObject({
      limit_price: '100.13',
      stop_price: '99.99',
      trail_price: '1.24',
      trail_percent: '1.5',
      take_profit: { limit_price: '110.13' },
      stop_loss: { stop_price: '95.12', limit_price: '94.12' },
    });
  });

  it('collects validation, sizing, risk, reference and order-shape rejections before submit', async () => {
    const submit = vi.fn(async () => {
      throw new Error('submit must not be reached');
    });
    const { executor } = await setup(submit, {
      finalValidate: async () => ['POLICY_REJECTED'],
      recalculateSizing: async () => ({
        ...sizing,
        approved: false,
        quantity: new Decimal(0),
        notional: new Decimal(0),
        reasons: ['ZERO_QUANTITY'],
      }),
      finalRiskGate: async () => ({
        id: 'risk-rejected',
        outcome: 'REJECTED',
        signalId: 'signal',
        symbol: 'AAPL',
        evaluatedAt: now,
        reasonCodes: ['DAILY_LOSS_LIMIT'],
        configurationSnapshotId: riskSnapshot.id,
        decisionSnapshot: {},
      }),
      getReferencePrice: async () => new Decimal(-1),
    });
    const candidate = intent();
    const result = await executor.execute({
      ...candidate,
      signal: {
        ...candidate.signal,
        configurationSnapshot: { signalPrice: 'invalid' },
      },
      specification: {
        ...candidate.specification,
        type: 'stop_limit',
        timeInForce: 'gtc',
        orderClass: 'bracket',
        extendedHours: true,
      },
    });
    expect(result.intentState).toBe('REJECTED');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'POLICY_REJECTED',
        'SIZING:ZERO_QUANTITY',
        'RISK:DAILY_LOSS_LIMIT',
        'INVALID_QUANTITY_OR_NOTIONAL',
        'INVALID_REFERENCE_PRICE',
        'LIMIT_PRICE_REQUIRED',
        'STOP_PRICE_REQUIRED',
        'EXTENDED_HOURS_REQUIRES_DAY_LIMIT_ORDER',
        'PROTECTIVE_LEGS_REQUIRED',
      ]),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects invalid trailing orders and stale signal/reference deviations', async () => {
    const submit = vi.fn(async () => {
      throw new Error('submit must not be reached');
    });
    const { executor } = await setup(submit, { getReferencePrice: async () => 120 });
    const candidate = intent();
    const result = await executor.execute({
      ...candidate,
      signal: { ...candidate.signal, configurationSnapshot: { signalPrice: 100 } },
      specification: {
        ...candidate.specification,
        type: 'trailing_stop',
        orderClass: 'bracket',
        limitPrice: 200,
        trailPrice: 1,
        trailPercent: 1,
      },
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'TRAILING_STOP_REQUIRES_ONE_TRAIL_VALUE_AND_SIMPLE_CLASS',
        'PRICE_SANITY_DEVIATION',
        'SIGNAL_TO_EXECUTION_PRICE_DEVIATION',
      ]),
    );
  });

  it('rejects a malformed persisted signal reference price', async () => {
    const submit = vi.fn(async () => {
      throw new Error('submit must not be reached');
    });
    const { executor } = await setup(submit);
    const candidate = intent();
    const result = await executor.execute({
      ...candidate,
      signal: { ...candidate.signal, configurationSnapshot: { signalPrice: 'invalid' } },
    });
    expect(result.reasons).toContain('INVALID_SIGNAL_REFERENCE_PRICE');
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a second active advanced protection group', async () => {
    const submit = vi.fn(async () => {
      throw new Error('submit must not be reached');
    });
    const { executor, repository } = await setup(submit);
    repository.hasActiveProtection = vi.fn(async () => true);
    const candidate = intent();
    const result = await executor.execute({
      ...candidate,
      specification: {
        ...candidate.specification,
        orderClass: 'bracket',
        takeProfitPrice: 110,
        stopLossPrice: 95,
      },
    });
    expect(result.reasons).toEqual(['DUPLICATE_POSITION_PROTECTION:AAPL|trend']);
    expect(submit).not.toHaveBeenCalled();
  });

  it('records deterministic broker rejections without requesting reconciliation', async () => {
    const submit = vi.fn(async () => {
      throw new Error('broker rejected request');
    });
    const { executor, reconcile } = await setup(submit);
    const result = await executor.execute(intent());
    expect(result).toMatchObject({
      intentState: 'REJECTED',
      reasons: ['broker rejected request'],
      reconciliationRequired: false,
    });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
