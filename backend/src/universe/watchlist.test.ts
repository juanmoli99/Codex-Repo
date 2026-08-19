import { describe, expect, it } from 'vitest';

import { alpacaAssetSchema } from '../alpaca/types.js';
import { UniverseFilter, WatchlistService } from './watchlist.js';

describe('watchlist and universe', () => {
  it('normalizes, deduplicates, disables, and expires blocks', () => {
    const service = new WatchlistService();
    expect(service.add(' spy ').symbol).toBe('SPY');
    expect(service.add('SPY')).toBe(service.list()[0]);
    service.setActive('SPY', false);
    expect(service.list(true)).toHaveLength(0);
    service.block('SPY', 'temporary', new Date(0));
    expect(service.currentBlock('SPY')).toBeUndefined();
  });

  it('rejects illiquid or blacklisted assets with explicit reasons', () => {
    const asset = alpacaAssetSchema.parse({
      id: 'asset',
      asset_class: 'us_equity',
      exchange: 'NASDAQ',
      symbol: 'XYZ',
      name: 'XYZ',
      status: 'active',
      tradable: true,
      marginable: true,
      shortable: true,
      easy_to_borrow: true,
      fractionable: true,
    });
    const result = new UniverseFilter().evaluate(
      asset,
      { price: 5, averageVolume: 10_000, dollarVolume: 50_000, bidPrice: 4.9, askPrice: 5.1 },
      {
        minimumPrice: 10,
        maximumPrice: 1_000,
        minimumAverageVolume: 1_000_000,
        minimumDollarVolume: 20_000_000,
        maximumSpreadBps: 20,
        whitelist: new Set(),
        blacklist: new Set(['XYZ']),
      },
      false,
      false,
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining(['BLACKLISTED', 'PRICE_FILTER', 'VOLUME_FILTER', 'SPREAD_FILTER']),
    );
  });
});
