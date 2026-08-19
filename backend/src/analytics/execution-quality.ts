import { Decimal } from 'decimal.js';

export interface ExecutionQualitySample {
  readonly id: string;
  readonly symbol: string;
  readonly strategyId: string;
  readonly orderType: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: Decimal.Value;
  readonly requestedQuantity: Decimal.Value;
  readonly decisionPrice: Decimal.Value;
  readonly signalPrice: Decimal.Value;
  readonly submissionPrice: Decimal.Value;
  readonly arrivalPrice: Decimal.Value;
  readonly expectedFillPrice: Decimal.Value;
  readonly fillPrice?: Decimal.Value;
  readonly spreadBps: Decimal.Value;
  readonly volatility: Decimal.Value;
  readonly signaledAt: Date;
  readonly submittedAt: Date;
  readonly acceptedAt?: Date;
  readonly filledAt?: Date;
  readonly rejected: boolean;
  readonly canceled: boolean;
  readonly partialFill: boolean;
}

export interface ExecutionQualityResult {
  readonly id: string;
  readonly absoluteSlippage: Decimal | null;
  readonly slippageBps: Decimal | null;
  readonly slippageMoney: Decimal | null;
  readonly fillRatio: Decimal;
  readonly signalToSubmitMs: number;
  readonly submitToAcceptedMs: number | null;
  readonly acceptedToFillMs: number | null;
}

export function measureExecutionQuality(sample: ExecutionQualitySample): ExecutionQualityResult {
  const requested = new Decimal(sample.requestedQuantity);
  const quantity = new Decimal(sample.quantity);
  const expected = new Decimal(sample.expectedFillPrice);
  const actual = sample.fillPrice === undefined ? null : new Decimal(sample.fillPrice);
  const direction = sample.side === 'buy' ? 1 : -1;
  const absoluteSlippage = actual === null ? null : actual.minus(expected).mul(direction);
  return {
    id: sample.id,
    absoluteSlippage,
    slippageBps:
      absoluteSlippage === null || expected.isZero()
        ? null
        : absoluteSlippage.div(expected).mul(10_000),
    slippageMoney: absoluteSlippage === null ? null : absoluteSlippage.mul(quantity),
    fillRatio: requested.gt(0) ? quantity.div(requested) : new Decimal(0),
    signalToSubmitMs: Math.max(0, sample.submittedAt.getTime() - sample.signaledAt.getTime()),
    submitToAcceptedMs:
      sample.acceptedAt === undefined
        ? null
        : Math.max(0, sample.acceptedAt.getTime() - sample.submittedAt.getTime()),
    acceptedToFillMs:
      sample.acceptedAt === undefined || sample.filledAt === undefined
        ? null
        : Math.max(0, sample.filledAt.getTime() - sample.acceptedAt.getTime()),
  };
}

export interface ExecutionQualityAggregate {
  readonly sampleCount: number;
  readonly fillRatio: Decimal;
  readonly partialFillRatio: Decimal;
  readonly rejectionRatio: Decimal;
  readonly cancelRatio: Decimal;
  readonly averageSlippageBps: Decimal | null;
  readonly degraded: boolean;
}

export function aggregateExecutionQuality(
  samples: readonly ExecutionQualitySample[],
  maximumAverageSlippageBps: Decimal.Value,
): ExecutionQualityAggregate {
  if (samples.length === 0)
    return {
      sampleCount: 0,
      fillRatio: new Decimal(0),
      partialFillRatio: new Decimal(0),
      rejectionRatio: new Decimal(0),
      cancelRatio: new Decimal(0),
      averageSlippageBps: null,
      degraded: false,
    };
  const measurements = samples.map(measureExecutionQuality);
  const slippages = measurements.flatMap((measurement) =>
    measurement.slippageBps === null ? [] : [measurement.slippageBps],
  );
  const denominator = new Decimal(samples.length);
  const averageSlippageBps =
    slippages.length === 0
      ? null
      : slippages.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(slippages.length);
  return {
    sampleCount: samples.length,
    fillRatio: measurements
      .reduce((sum, measurement) => sum.plus(measurement.fillRatio), new Decimal(0))
      .div(denominator),
    partialFillRatio: new Decimal(samples.filter((sample) => sample.partialFill).length).div(
      denominator,
    ),
    rejectionRatio: new Decimal(samples.filter((sample) => sample.rejected).length).div(
      denominator,
    ),
    cancelRatio: new Decimal(samples.filter((sample) => sample.canceled).length).div(denominator),
    averageSlippageBps,
    degraded: averageSlippageBps?.gt(maximumAverageSlippageBps) ?? false,
  };
}

export type ExecutionQualityDimension =
  'SYMBOL' | 'STRATEGY' | 'ORDER_TYPE' | 'HOUR_UTC' | 'VOLATILITY_BUCKET' | 'SIZE_BUCKET';

export function groupExecutionQuality(
  samples: readonly ExecutionQualitySample[],
  dimension: ExecutionQualityDimension,
  maximumAverageSlippageBps: Decimal.Value,
): Readonly<Record<string, ExecutionQualityAggregate>> {
  const groups = new Map<string, ExecutionQualitySample[]>();
  for (const sample of samples) {
    const key = qualityGroupKey(sample, dimension);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return Object.fromEntries(
    [...groups].map(([key, values]) => [
      key,
      aggregateExecutionQuality(values, maximumAverageSlippageBps),
    ]),
  );
}

function qualityGroupKey(
  sample: ExecutionQualitySample,
  dimension: ExecutionQualityDimension,
): string {
  switch (dimension) {
    case 'SYMBOL':
      return sample.symbol;
    case 'STRATEGY':
      return sample.strategyId;
    case 'ORDER_TYPE':
      return sample.orderType;
    case 'HOUR_UTC':
      return sample.submittedAt.getUTCHours().toString().padStart(2, '0');
    case 'VOLATILITY_BUCKET': {
      const volatility = new Decimal(sample.volatility);
      return volatility.lt(0.2) ? 'LOW' : volatility.lt(0.5) ? 'MEDIUM' : 'HIGH';
    }
    case 'SIZE_BUCKET': {
      const notional = new Decimal(sample.quantity).mul(sample.submissionPrice);
      return notional.lt(1_000) ? 'SMALL' : notional.lt(10_000) ? 'MEDIUM' : 'LARGE';
    }
  }
}
