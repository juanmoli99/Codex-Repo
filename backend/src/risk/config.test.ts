import { describe, expect, it } from 'vitest';
import {
  conservativeLiveRiskConfiguration,
  conservativePaperRiskConfiguration,
  createRiskConfigurationSnapshot,
} from './config.js';

describe('risk configuration', () => {
  it('creates a validated immutable versioned snapshot', () => {
    const snapshot = createRiskConfigurationSnapshot(
      conservativePaperRiskConfiguration,
      new Date('2026-08-18T00:00:00Z'),
    );
    expect(snapshot.id).toMatch(/^paper-v1:/);
    expect(snapshot.checksum).toHaveLength(64);
    expect(Object.isFrozen(snapshot.configuration)).toBe(true);
  });

  it('rejects internally inconsistent exposure configuration', () => {
    expect(() =>
      createRiskConfigurationSnapshot(
        {
          ...conservativePaperRiskConfiguration,
          maximumCapitalPerTradePercent: 30,
          maximumAssetExposurePercent: 10,
        },
        new Date(),
      ),
    ).toThrow();
  });

  it('pins conservative initial LIVE absolute limits', () => {
    const snapshot = createRiskConfigurationSnapshot(
      conservativeLiveRiskConfiguration,
      new Date('2026-08-18T00:00:00Z'),
    );
    expect(snapshot.configuration).toMatchObject({
      maximumOrderNotional: 100,
      maximumTotalCapital: 500,
      dailyLossLimitAmount: 25,
      maximumDrawdownPercent: 3,
      minimumAccountEquity: 1_000,
    });
  });
});
