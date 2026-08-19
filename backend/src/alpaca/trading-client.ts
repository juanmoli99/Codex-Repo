import { z } from 'zod';

import type { AlpacaHttpClient } from './http-client.js';
import {
  alpacaAccountSchema,
  alpacaActivitySchema,
  alpacaAssetSchema,
  alpacaCalendarDaySchema,
  alpacaClockSchema,
  alpacaOrderSchema,
  alpacaPositionSchema,
  type AlpacaAccount,
  type AlpacaActivity,
  type AlpacaAsset,
  type AlpacaCalendarDay,
  type AlpacaClock,
  type AlpacaOrder,
  type AlpacaOrderRequest,
  type AlpacaPosition,
  type ExternalActivityFinding,
} from './types.js';

const voidResponseSchema = z.union([z.undefined(), z.object({})]);

export class AlpacaTradingClient {
  public constructor(private readonly http: AlpacaHttpClient) {}

  public getAccount(): Promise<AlpacaAccount> {
    return this.http.request({
      service: 'trading',
      method: 'GET',
      path: '/v2/account',
      schema: alpacaAccountSchema,
    });
  }

  public getClock(): Promise<AlpacaClock> {
    return this.http.request({
      service: 'trading',
      method: 'GET',
      path: '/v2/clock',
      schema: alpacaClockSchema,
    });
  }

  public getCalendar(start: string, end: string): Promise<AlpacaCalendarDay[]> {
    return this.http.request({
      service: 'trading',
      method: 'GET',
      path: '/v2/calendar',
      query: { start, end, date_type: 'TRADING' },
      schema: z.array(alpacaCalendarDaySchema),
    });
  }

  public getAsset(symbolOrId: string): Promise<AlpacaAsset> {
    return this.http.request({
      service: 'trading',
      method: 'GET',
      path: `/v2/assets/${encodeURIComponent(symbolOrId)}`,
      schema: alpacaAssetSchema,
    });
  }

  public listAssets(status = 'active'): Promise<AlpacaAsset[]> {
    return this.http.request({
      service: 'trading',
      method: 'GET',
      path: '/v2/assets',
      query: { status, asset_class: 'us_equity' },
      schema: z.array(alpacaAssetSchema),
    });
  }

  public listOrders(status: 'open' | 'closed' | 'all' = 'open'): Promise<AlpacaOrder[]> {
    return this.http.request({
      service: 'trading',
      method: 'GET',
      path: '/v2/orders',
      query: { status, nested: true, direction: 'asc', limit: 500 },
      schema: z.array(alpacaOrderSchema),
    });
  }

  public getOrder(orderId: string): Promise<AlpacaOrder> {
    return this.http.request({
      service: 'trading',
      method: 'GET',
      path: `/v2/orders/${encodeURIComponent(orderId)}`,
      query: { nested: true },
      schema: alpacaOrderSchema,
    });
  }

  public listPositions(): Promise<AlpacaPosition[]> {
    return this.http.request({
      service: 'trading',
      method: 'GET',
      path: '/v2/positions',
      schema: z.array(alpacaPositionSchema),
    });
  }

  public async listActivities(
    activityTypes?: readonly string[],
    after?: string,
  ): Promise<AlpacaActivity[]> {
    const activities: AlpacaActivity[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const batch = await this.http.request({
        service: 'trading',
        method: 'GET',
        path: '/v2/account/activities',
        query: {
          ...(activityTypes?.length ? { activity_types: activityTypes.join(',') } : {}),
          ...(after ? { after } : {}),
          ...(pageToken ? { page_token: pageToken } : {}),
          direction: 'asc',
          page_size: 100,
        },
        schema: z.array(alpacaActivitySchema),
      });
      activities.push(...batch);
      if (batch.length < 100) return activities;
      const next = batch.at(-1)?.id;
      if (!next || seenTokens.has(next)) throw new Error('ALPACA_ACTIVITY_PAGINATION_LOOP');
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error('ALPACA_ACTIVITY_PAGE_LIMIT');
  }

  public submitOrder(order: AlpacaOrderRequest): Promise<AlpacaOrder> {
    return this.http.request({
      service: 'trading',
      method: 'POST',
      path: '/v2/orders',
      body: order,
      schema: alpacaOrderSchema,
      retryMode: 'NEVER',
      operationKey: order.client_order_id,
    });
  }

  public cancelOrder(orderId: string): Promise<unknown> {
    return this.http.request({
      service: 'trading',
      method: 'DELETE',
      path: `/v2/orders/${encodeURIComponent(orderId)}`,
      schema: voidResponseSchema,
      retryMode: 'NEVER',
      operationKey: `cancel:${orderId}`,
    });
  }

  public cancelAllOrders(): Promise<unknown[]> {
    return this.http.request({
      service: 'trading',
      method: 'DELETE',
      path: '/v2/orders',
      schema: z.array(z.unknown()),
      retryMode: 'NEVER',
      operationKey: 'cancel-all',
    });
  }

  public replaceOrder(
    orderId: string,
    replacement: Readonly<Record<string, string>>,
  ): Promise<AlpacaOrder> {
    return this.http.request({
      service: 'trading',
      method: 'PATCH',
      path: `/v2/orders/${encodeURIComponent(orderId)}`,
      body: replacement,
      schema: alpacaOrderSchema,
      retryMode: 'NEVER',
      operationKey: `replace:${orderId}`,
    });
  }

  public detectExternalOrders(
    orders: readonly AlpacaOrder[],
    ownedClientOrderIds: ReadonlySet<string>,
  ): ExternalActivityFinding[] {
    return orders
      .filter((order) => !ownedClientOrderIds.has(order.client_order_id))
      .map((order) => ({
        kind: 'EXTERNAL_ORDER',
        brokerOrderId: order.id,
        clientOrderId: order.client_order_id,
        symbol: order.symbol,
        status: order.status,
      }));
  }
}
