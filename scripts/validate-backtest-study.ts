import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { validateBacktestStudy, type BacktestStudyRun } from '../backend/src/backtesting/study.js';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: pnpm backtest:validate -- <study-runs.json>');
const source = await readFile(resolve(inputPath), 'utf8');
const parsed: unknown = JSON.parse(source);
if (!Array.isArray(parsed)) throw new Error('Study input must be a JSON array');
const report = validateBacktestStudy(parsed as BacktestStudyRun[]);
const canonical = JSON.stringify(report);
process.stdout.write(
  `${JSON.stringify(
    {
      ...report,
      artifactSha256: createHash('sha256').update(source).update(canonical).digest('hex'),
    },
    undefined,
    2,
  )}\n`,
);
if (!report.accepted) process.exitCode = 2;
