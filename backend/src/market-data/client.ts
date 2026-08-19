import { z } from 'zod';

import type { AlpacaHttpClient } from '../alpaca/http-client.js';
import type { MarketDataCache } from './cache.js';
import type { MarketBar, MarketQuote, MarketTrade, Timeframe } from './types.js';

const wireBarSchema = z.object({
  t: z.iso.datetime({ offset: true }),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
  n: z.number().optional(),
  vw: z.number().optional(),
});
const wireQuoteSchema = z.object({
  t: z.iso.datetime({ offset: true }),
  bp: z.number(),
  bs: z.number(),
  ap: z.number(),
  as: z.number(),
});
const wireTradeSchema = z.object({
  t: z.iso.datetime({ offset: true }),
  p: z.number(),
  s: z.number(),
  i: z.union([z.string(), z.number()]),
});
const barsResponseSchema = z.looseObject({
  bars: z.record(z.string(), z.array(wireBarSchema)),
  next_page_token: z.string().nullable().optional(),
});
const latestBarsResponseSchema = z.looseObject({
  bars: z.record(z.string(), wireBarSchema),
});
const quotesResponseSchema = z.looseObject({
  quotes: z.record(z.string(), z.array(wireQuoteSchema)),
  next_page_token: z.string().nullable().optional(),
});
const latestQuotesResponseSchema = z.looseObject({
  quotes: z.record(z.string(), wireQuoteSchema),
});
const tradesResponseSchema = z.looseObject({
  trades: z.record(z.string(), z.array(wireTradeSchema)),
  next_page_token: z.string().nullable().optional(),
});
const latestTradesResponseSchema = z.looseObject({
  trades: z.record(z.string(), wireTradeSchema),
});

function normalizeBar(symbol: string, bar: z.infer<typeof wireBarSchema>): MarketBar {
  return {
    symbol,
    timestamp: new Date(bar.t),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
    ...(bar.n === undefined ? {} : { tradeCount: bar.n }),
    ...(bar.vw === undefined ? {} : { vwap: bar.vw }),
  };
}

function normalizeQuote(symbol: string, quote: z.infer<typeof wireQuoteSchema>): MarketQuote {
  return {
    symbol,
    timestamp: new Date(quote.t),
    bidPrice: quote.bp,
    bidSize: quote.bs,
    askPrice: quote.ap,
    askSize: quote.as,
  };
}

function normalizeTrade(symbol: string, trade: z.infer<typeof wireTradeSchema>): MarketTrade {
  return {
    symbol,
    timestamp: new Date(trade.t),
    price: trade.p,
    size: trade.s,
    id: String(trade.i),
  };
}

function advancePageToken(
  next: string | null | undefined,
  seen: Set<string>,
  pageCount: number,
): string | undefined {
  if (!next) return undefined;
  if (pageCount >= 100) throw new Error('ALPACA_PAGINATION_PAGE_LIMIT');
  if (seen.has(next)) throw new Error('ALPACA_PAGINATION_TOKEN_LOOP');
  seen.add(next);
  return next;
}

export class AlpacaMarketDataClient {
  public constructor(
    private readonly http: AlpacaHttpClient,
    private readonly cache: MarketDataCache,
    private readonly feed: 'iex' | 'sip' = 'iex',
  ) {}

  public getHistoricalBars(input: {
    readonly symbols: readonly string[];
    readonly timeframe: Timeframe;
    readonly start: Date;
    readonly end: Date;
    readonly adjusted?: boolean;
  }): Promise<MarketBar[]> {
    const symbols = [...new Set(input.symbols.map((symbol) => symbol.toUpperCase()))].sort();
    const cacheKey = `bars:${symbols.join(',')}:${input.timeframe}:${input.start.toISOString()}:${input.end.toISOString()}:${input.adjusted !== false}`;
    return this.cache.getOrLoad(cacheKey, 30_000, async () => {
      const result: MarketBar[] = [];
      let pageToken: string | undefined;
      let pageCount = 0;
      const seenTokens = new Set<string>();
      do {
        pageCount += 1;
        const page = await this.http.request({
          service: 'data',
          method: 'GET',
          path: '/v2/stocks/bars',
          query: {
            symbols: symbols.join(','),
            timeframe: input.timeframe,
            start: input.start.toISOString(),
            end: input.end.toISOString(),
            adjustment: input.adjusted === false ? 'raw' : 'all',
            feed: this.feed,
            sort: 'asc',
            limit: 10_000,
            page_token: pageToken,
          },
          schema: barsResponseSchema,
          rateCost: 2,
        });
        for (const [symbol, bars] of Object.entries(page.bars)) {
          result.push(...bars.map((bar) => normalizeBar(symbol, bar)));
        }
        pageToken = advancePageToken(page.next_page_token, seenTokens, pageCount);
      } while (pageToken);
      return result.sort(
        (left, right) =>
          left.symbol.localeCompare(right.symbol) ||
          left.timestamp.getTime() - right.timestamp.getTime(),
      );
    });
  }

  public getLatestBars(symbols: readonly string[]): Promise<MarketBar[]> {
    const normalized = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].sort();
    return this.cache.getOrLoad(`latest-bars:${normalized.join(',')}`, 1_000, async () => {
      const response = await this.http.request({
        service: 'data',
        method: 'GET',
        path: '/v2/stocks/bars/latest',
        query: { symbols: normalized.join(','), feed: this.feed },
        schema: latestBarsResponseSchema,
      });
      return Object.entries(response.bars).map(([symbol, bar]) => normalizeBar(symbol, bar));
    });
  }

  public getHistoricalQuotes(
    symbols: readonly string[],
    start: Date,
    end: Date,
  ): Promise<MarketQuote[]> {
    return this.paginateQuotes([...new Set(symbols)].sort(), start, end);
  }

  private async paginateQuotes(
    symbols: readonly string[],
    start: Date,
    end: Date,
  ): Promise<MarketQuote[]> {
    const result: MarketQuote[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    const seenTokens = new Set<string>();
    do {
      pageCount += 1;
      const page = await this.http.request({
        service: 'data',
        method: 'GET',
        path: '/v2/stocks/quotes',
        query: {
          symbols: symbols.join(','),
          start: start.toISOString(),
          end: end.toISOString(),
          feed: this.feed,
          limit: 10_000,
          page_token: pageToken,
        },
        schema: quotesResponseSchema,
        rateCost: 2,
      });
      for (const [symbol, quotes] of Object.entries(page.quotes)) {
        result.push(...quotes.map((quote) => normalizeQuote(symbol, quote)));
      }
      pageToken = advancePageToken(page.next_page_token, seenTokens, pageCount);
    } while (pageToken);
    return result;
  }

  public getLatestQuotes(symbols: readonly string[]): Promise<MarketQuote[]> {
    const normalized = [...new Set(symbols)].sort();
    return this.cache.getOrLoad(`latest-quotes:${normalized.join(',')}`, 500, async () => {
      const response = await this.http.request({
        service: 'data',
        method: 'GET',
        path: '/v2/stocks/quotes/latest',
        query: { symbols: normalized.join(','), feed: this.feed },
        schema: latestQuotesResponseSchema,
      });
      return Object.entries(response.quotes).map(([symbol, quote]) =>
        normalizeQuote(symbol, quote),
      );
    });
  }

  public async getHistoricalTrades(
    symbols: readonly string[],
    start: Date,
    end: Date,
  ): Promise<MarketTrade[]> {
    const result: MarketTrade[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    const seenTokens = new Set<string>();
    do {
      pageCount += 1;
      const page = await this.http.request({
        service: 'data',
        method: 'GET',
        path: '/v2/stocks/trades',
        query: {
          symbols: [...new Set(symbols)].sort().join(','),
          start: start.toISOString(),
          end: end.toISOString(),
          feed: this.feed,
          limit: 10_000,
          page_token: pageToken,
        },
        schema: tradesResponseSchema,
        rateCost: 2,
      });
      for (const [symbol, trades] of Object.entries(page.trades)) {
        result.push(...trades.map((trade) => normalizeTrade(symbol, trade)));
      }
      pageToken = advancePageToken(page.next_page_token, seenTokens, pageCount);
    } while (pageToken);
    return result;
  }

  public getLatestTrades(symbols: readonly string[]): Promise<MarketTrade[]> {
    const normalized = [...new Set(symbols)].sort();
    return this.cache.getOrLoad(`latest-trades:${normalized.join(',')}`, 500, async () => {
      const response = await this.http.request({
        service: 'data',
        method: 'GET',
        path: '/v2/stocks/trades/latest',
        query: { symbols: normalized.join(','), feed: this.feed },
        schema: latestTradesResponseSchema,
      });
      return Object.entries(response.trades).map(([symbol, trade]) =>
        normalizeTrade(symbol, trade),
      );
    });
  }
}
