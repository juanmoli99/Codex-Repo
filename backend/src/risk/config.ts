import { createHash } from 'node:crypto';
import { z } from 'zod';

const percent = z.number().min(0).max(100);
const positive = z.number().positive();
const nonNegative = z.number().nonnegative();

export const riskConfigurationSchema = z
  .object({
    version: z.string().min(1),
    maximumRiskPerTradePercent: percent,
    maximumLossPerTrade: positive,
    maximumOrderNotional: positive,
    maximumTotalCapital: positive,
    maximumCapitalPerTradePercent: percent,
    maximumAssetExposurePercent: percent,
    maximumGlobalExposurePercent: z.number().positive().max(500),
    maximumConcentrationPercent: percent,
    maximumPositions: z.number().int().positive(),
    maximumOpenOrders: z.number().int().positive(),
    maximumDailyTrades: z.number().int().positive(),
    dailyLossLimitPercent: percent,
    dailyLossLimitAmount: positive,
    maximumDrawdownPercent: percent,
    minimumAccountEquity: nonNegative,
    minimumCash: nonNegative,
    minimumBuyingPower: nonNegative,
    maximumAggregateRiskPercent: percent,
    minimumAverageDailyDollarVolume: nonNegative,
    maximumSpreadBps: nonNegative,
    maximumAnnualizedVolatility: nonNegative,
    allowedSessionStart: z.string().regex(/^\d{2}:\d{2}$/),
    allowedSessionEnd: z.string().regex(/^\d{2}:\d{2}$/),
    strategyLimits: z.record(
      z.string(),
      z.object({
        maximumRiskPercent: percent,
        maximumDailyTrades: z.number().int().positive(),
      }),
    ),
    symbolLimits: z.record(
      z.string(),
      z.object({ maximumExposurePercent: percent, maximumNotional: positive }),
    ),
  })
  .superRefine((value, context) => {
    if (value.maximumRiskPerTradePercent > value.maximumAggregateRiskPercent)
      context.addIssue({
        code: 'custom',
        path: ['maximumRiskPerTradePercent'],
        message: 'Per-trade risk cannot exceed aggregate risk',
      });
    if (value.maximumCapitalPerTradePercent > value.maximumAssetExposurePercent)
      context.addIssue({
        code: 'custom',
        path: ['maximumCapitalPerTradePercent'],
        message: 'Per-trade capital cannot exceed per-asset exposure',
      });
  });

export type RiskConfiguration = z.infer<typeof riskConfigurationSchema>;

export interface RiskConfigurationSnapshot {
  readonly id: string;
  readonly configuration: Readonly<RiskConfiguration>;
  readonly checksum: string;
  readonly createdAt: Date;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  return value;
}

export function createRiskConfigurationSnapshot(
  input: unknown,
  createdAt: Date,
): RiskConfigurationSnapshot {
  const configuration = riskConfigurationSchema.parse(input);
  const canonical = JSON.stringify(canonicalize(configuration));
  return {
    id: `${configuration.version}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`,
    configuration: Object.freeze(configuration),
    checksum: createHash('sha256').update(canonical).digest('hex'),
    createdAt: new Date(createdAt),
  };
}

export const conservativePaperRiskConfiguration: RiskConfiguration = {
  version: 'paper-v1',
  maximumRiskPerTradePercent: 0.5,
  maximumLossPerTrade: 100,
  maximumOrderNotional: 10_000,
  maximumTotalCapital: 50_000,
  maximumCapitalPerTradePercent: 10,
  maximumAssetExposurePercent: 15,
  maximumGlobalExposurePercent: 50,
  maximumConcentrationPercent: 15,
  maximumPositions: 6,
  maximumOpenOrders: 6,
  maximumDailyTrades: 10,
  dailyLossLimitPercent: 2,
  dailyLossLimitAmount: 1_000,
  maximumDrawdownPercent: 8,
  minimumAccountEquity: 0,
  minimumCash: 500,
  minimumBuyingPower: 500,
  maximumAggregateRiskPercent: 3,
  minimumAverageDailyDollarVolume: 10_000_000,
  maximumSpreadBps: 25,
  maximumAnnualizedVolatility: 0.8,
  allowedSessionStart: '09:35',
  allowedSessionEnd: '15:45',
  strategyLimits: {},
  symbolLimits: {},
};

/**
 * Deliberately small, absolute first-deployment limits. Increasing any value requires a new
 * immutable configuration version and a fresh LIVE-readiness assessment.
 */
export const conservativeLiveRiskConfiguration: RiskConfiguration = {
  version: 'live-initial-v1',
  maximumRiskPerTradePercent: 0.25,
  maximumLossPerTrade: 10,
  maximumOrderNotional: 100,
  maximumTotalCapital: 500,
  maximumCapitalPerTradePercent: 10,
  maximumAssetExposurePercent: 10,
  maximumGlobalExposurePercent: 50,
  maximumConcentrationPercent: 10,
  maximumPositions: 3,
  maximumOpenOrders: 3,
  maximumDailyTrades: 5,
  dailyLossLimitPercent: 2.5,
  dailyLossLimitAmount: 25,
  maximumDrawdownPercent: 3,
  minimumAccountEquity: 1_000,
  minimumCash: 0,
  minimumBuyingPower: 0,
  maximumAggregateRiskPercent: 1,
  minimumAverageDailyDollarVolume: 25_000_000,
  maximumSpreadBps: 15,
  maximumAnnualizedVolatility: 0.6,
  allowedSessionStart: '09:40',
  allowedSessionEnd: '15:30',
  strategyLimits: {},
  symbolLimits: {},
};
