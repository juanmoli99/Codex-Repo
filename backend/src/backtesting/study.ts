export interface BacktestStudyRun {
  readonly id: string;
  readonly fold: string;
  readonly segment: 'IN_SAMPLE' | 'OUT_OF_SAMPLE';
  readonly symbol: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly parameterSet: string;
  readonly costBps: number;
  readonly regime: string;
  readonly tradeCount: number;
  readonly netProfit: number;
  readonly alphaPercent: number;
  readonly turnover: number;
  readonly capacityConstrainedTrades: number;
}

export interface StudyCheck {
  readonly passed: boolean;
  readonly evidence: string;
}

export interface BacktestStudyReport {
  readonly accepted: boolean;
  readonly checks: Readonly<{
    walkForward: StudyCheck;
    outOfSample: StudyCheck;
    parameterSensitivity: StudyCheck;
    costStress: StudyCheck;
    regimeSegmentation: StudyCheck;
    symbolAndPeriodDiversity: StudyCheck;
    benchmarkAlpha: StudyCheck;
    capacity: StudyCheck;
    minimumSample: StudyCheck;
    bootstrap: StudyCheck;
  }>;
  readonly bootstrapNetProfit?: Readonly<{ p05: number; p50: number; p95: number }>;
}

export function validateBacktestStudy(
  input: readonly BacktestStudyRun[],
  options: {
    readonly minimumOutOfSampleTrades?: number;
    readonly maximumCapacityConstrainedRatio?: number;
  } = {},
): BacktestStudyReport {
  const runs = [...input].sort((left, right) => left.id.localeCompare(right.id));
  for (const run of runs) validateRun(run);
  const outOfSample = runs.filter((run) => run.segment === 'OUT_OF_SAMPLE');
  const folds = new Map<string, Set<BacktestStudyRun['segment']>>();
  for (const run of runs) {
    const segments = folds.get(run.fold) ?? new Set();
    segments.add(run.segment);
    folds.set(run.fold, segments);
  }
  const completeFolds = [...folds.values()].filter(
    (segments) => segments.has('IN_SAMPLE') && segments.has('OUT_OF_SAMPLE'),
  ).length;
  const parameterSets = new Set(runs.map((run) => run.parameterSet));
  const costLevels = new Set(runs.map((run) => run.costBps));
  const stressed = outOfSample.filter(
    (run) => run.costBps > minimum(runs.map((run) => run.costBps)),
  );
  const regimes = new Set(outOfSample.map((run) => run.regime));
  const symbols = new Set(outOfSample.map((run) => run.symbol));
  const periods = new Set(
    outOfSample.map((run) => `${run.periodStart.slice(0, 7)}:${run.periodEnd.slice(0, 7)}`),
  );
  const trades = outOfSample.reduce((sum, run) => sum + run.tradeCount, 0);
  const alpha = outOfSample.reduce((sum, run) => sum + run.alphaPercent, 0);
  const constrainedTrades = outOfSample.reduce(
    (sum, run) => sum + run.capacityConstrainedTrades,
    0,
  );
  const constrainedRatio = trades === 0 ? 1 : constrainedTrades / trades;
  const bootstrap = bootstrapTotals(outOfSample.map((run) => run.netProfit));
  const checks = {
    walkForward: {
      passed: completeFolds >= 2,
      evidence: `${completeFolds} folds contain chronological in-sample and out-of-sample segments`,
    },
    outOfSample: {
      passed: outOfSample.length >= 2,
      evidence: `${outOfSample.length} out-of-sample runs`,
    },
    parameterSensitivity: {
      passed: parameterSets.size >= 3,
      evidence: `${parameterSets.size} distinct parameter sets`,
    },
    costStress: {
      passed:
        costLevels.size >= 3 && stressed.length > 0 && stressed.some((run) => run.netProfit > 0),
      evidence: `${costLevels.size} cost levels; ${stressed.filter((run) => run.netProfit > 0).length}/${stressed.length} stressed OOS runs profitable`,
    },
    regimeSegmentation: {
      passed: regimes.size >= 3,
      evidence: `${regimes.size} out-of-sample regimes`,
    },
    symbolAndPeriodDiversity: {
      passed: symbols.size >= 3 && periods.size >= 2,
      evidence: `${symbols.size} symbols and ${periods.size} distinct periods`,
    },
    benchmarkAlpha: {
      passed: outOfSample.length > 0 && alpha / outOfSample.length > 0,
      evidence: `mean OOS alpha=${outOfSample.length === 0 ? 0 : alpha / outOfSample.length}%`,
    },
    capacity: {
      passed:
        constrainedRatio <= (options.maximumCapacityConstrainedRatio ?? 0.1) &&
        outOfSample.every((run) => Number.isFinite(run.turnover) && run.turnover >= 0),
      evidence: `${(constrainedRatio * 100).toFixed(2)}% of OOS trades capacity-constrained`,
    },
    minimumSample: {
      passed: trades >= (options.minimumOutOfSampleTrades ?? 100),
      evidence: `${trades} OOS trades`,
    },
    bootstrap: {
      passed: bootstrap !== undefined && bootstrap.p05 > 0,
      evidence: bootstrap
        ? `sequence bootstrap P05/P50/P95=${bootstrap.p05}/${bootstrap.p50}/${bootstrap.p95}`
        : 'At least five OOS run outcomes are required for sequence bootstrap',
    },
  } as const;
  return {
    accepted: Object.values(checks).every((check) => check.passed),
    checks,
    ...(bootstrap ? { bootstrapNetProfit: bootstrap } : {}),
  };
}

function validateRun(run: BacktestStudyRun): void {
  if (!run.id || !run.fold || !run.symbol || !run.parameterSet || !run.regime)
    throw new Error('Study run identifiers are required');
  if (!/^\d{4}-\d{2}-\d{2}/.test(run.periodStart) || !/^\d{4}-\d{2}-\d{2}/.test(run.periodEnd))
    throw new Error(`Invalid study period for ${run.id}`);
  for (const value of [
    run.costBps,
    run.tradeCount,
    run.netProfit,
    run.alphaPercent,
    run.turnover,
    run.capacityConstrainedTrades,
  ])
    if (!Number.isFinite(value)) throw new Error(`Non-finite study metric for ${run.id}`);
  if (run.tradeCount < 0 || run.capacityConstrainedTrades < 0 || run.costBps < 0)
    throw new Error(`Negative count/cost for ${run.id}`);
}

function minimum(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

function bootstrapTotals(
  values: readonly number[],
): { p05: number; p50: number; p95: number } | undefined {
  if (values.length < 5) return undefined;
  let seed = 0x9e3779b9;
  const random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  const totals: number[] = [];
  for (let simulation = 0; simulation < 2_000; simulation += 1) {
    let total = 0;
    values.forEach(() => {
      const sampled = values.at(Math.floor(random() * values.length));
      if (sampled === undefined) throw new Error('Bootstrap sample unexpectedly missing');
      total += sampled;
    });
    totals.push(total);
  }
  totals.sort((left, right) => left - right);
  const p05 = totals.at(Math.floor(totals.length * 0.05));
  const p50 = totals.at(Math.floor(totals.length * 0.5));
  const p95 = totals.at(Math.floor(totals.length * 0.95));
  if (p05 === undefined || p50 === undefined || p95 === undefined)
    throw new Error('Bootstrap quantiles unexpectedly missing');
  return { p05, p50, p95 };
}
