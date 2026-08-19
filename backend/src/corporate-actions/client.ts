import { z } from 'zod';

import type { AlpacaHttpClient } from '../alpaca/http-client.js';

const corporateActionsResponseSchema = z.looseObject({
  corporate_actions: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
  next_page_token: z.string().nullable().optional(),
});

export interface CorporateActionWireRecord {
  readonly category: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export class AlpacaCorporateActionsClient {
  public constructor(private readonly http: AlpacaHttpClient) {}

  public async list(
    since: Date,
    until: Date,
    symbols?: readonly string[],
  ): Promise<CorporateActionWireRecord[]> {
    const records: CorporateActionWireRecord[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    const seenTokens = new Set<string>();
    do {
      pageCount += 1;
      const response = await this.http.request({
        service: 'data',
        method: 'GET',
        path: '/v1/corporate-actions',
        query: {
          since: since.toISOString(),
          until: until.toISOString(),
          symbols: symbols?.join(','),
          ca_types: 'all',
          cas_region: 'us',
          page_token: pageToken,
        },
        schema: corporateActionsResponseSchema,
      });
      for (const [category, values] of Object.entries(response.corporate_actions ?? {})) {
        records.push(...values.map((value) => ({ category, value })));
      }
      const next = response.next_page_token ?? undefined;
      if (next && (pageCount >= 100 || seenTokens.has(next)))
        throw new Error(
          pageCount >= 100 ? 'ALPACA_PAGINATION_PAGE_LIMIT' : 'ALPACA_PAGINATION_TOKEN_LOOP',
        );
      if (next) seenTokens.add(next);
      pageToken = next;
    } while (pageToken);
    return records;
  }
}
