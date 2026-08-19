import type { Logger } from 'pino';
import WebSocket from 'ws';

import type { AppConfig } from '../core/config.js';
import { parseMarketStreamMessage } from './halts.js';
import type { TradingHaltService } from './halts.js';
import type { MarketBar, MarketQuote, MarketTrade } from './types.js';
import type { MarketDataHealthService } from './validator.js';

export type MarketStreamState =
  'STOPPED' | 'CONNECTING' | 'AUTHENTICATING' | 'SUBSCRIBED' | 'RECONNECTING';

export interface MarketStreamHooks {
  readonly onBar?: (bar: MarketBar) => Promise<void> | void;
  readonly onQuote?: (quote: MarketQuote) => Promise<void> | void;
  readonly onTrade?: (trade: MarketTrade) => Promise<void> | void;
  readonly onDisconnected?: (symbols: readonly string[], disconnectedAt: Date) => Promise<void>;
  readonly onRecovered?: (
    symbols: readonly string[],
    disconnectedAt: Date,
    reconnectedAt: Date,
  ) => Promise<void>;
}

export class AlpacaMarketStream {
  private socket: WebSocket | null = null;
  private stateValue: MarketStreamState = 'STOPPED';
  private reconnectAttempt = 0;
  private stopped = true;
  private disconnectedAt: Date | undefined;
  private subscribedSymbols = new Set<string>();

  public constructor(
    private readonly config: AppConfig,
    private readonly haltService: TradingHaltService,
    private readonly healthService: MarketDataHealthService,
    private readonly logger: Logger,
    private readonly feed: 'iex' | 'sip' = 'iex',
    private readonly hooks: MarketStreamHooks = {},
    private readonly websocketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  public state(): MarketStreamState {
    return this.stateValue;
  }

  public async start(symbols: readonly string[]): Promise<void> {
    if (!this.stopped) return;
    const normalized = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].sort();
    if (normalized.length === 0) return;
    this.subscribedSymbols = new Set(normalized);
    this.stopped = false;
    await this.connect(normalized);
  }

  public async replaceSymbols(symbols: readonly string[]): Promise<void> {
    const normalized = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].sort();
    if (normalized.length === 0) {
      this.stop();
      this.subscribedSymbols.clear();
      return;
    }
    if (this.stopped) {
      await this.start(normalized);
      return;
    }
    const desired = new Set(normalized);
    const added = normalized.filter((symbol) => !this.subscribedSymbols.has(symbol));
    const removed = [...this.subscribedSymbols].filter((symbol) => !desired.has(symbol));
    this.subscribedSymbols = desired;
    if (this.stateValue !== 'SUBSCRIBED' || this.socket === null) return;
    if (removed.length > 0)
      this.socket.send(
        JSON.stringify({
          action: 'unsubscribe',
          bars: removed,
          quotes: removed,
          trades: removed,
          statuses: removed,
          lulds: removed,
        }),
      );
    if (added.length > 0) {
      for (const symbol of added) this.healthService.beginWarmup(symbol);
      this.socket.send(
        JSON.stringify({
          action: 'subscribe',
          bars: added,
          quotes: added,
          trades: added,
          statuses: added,
          lulds: added,
        }),
      );
    }
  }

  public stop(): void {
    this.stopped = true;
    this.stateValue = 'STOPPED';
    this.socket?.close(1_000, 'controlled shutdown');
    this.socket = null;
  }

  private async connect(symbols: readonly string[]): Promise<void> {
    if (this.stopped) return;
    this.stateValue = this.reconnectAttempt === 0 ? 'CONNECTING' : 'RECONNECTING';
    for (const symbol of symbols) this.healthService.markUnavailable(symbol);
    const url = `wss://stream.data.alpaca.markets/v2/${this.feed}`;
    const socket = this.websocketFactory(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let subscribed = false;
      const authenticationTimer = setTimeout(
        () => reject(new Error('ALPACA_MARKET_STREAM_AUTHENTICATION_TIMEOUT')),
        10_000,
      );
      authenticationTimer.unref();
      const onOpen = (): void => {
        this.stateValue = 'AUTHENTICATING';
        const key =
          this.config.trading.mode === 'PAPER'
            ? this.config.alpaca.paperKey
            : this.config.alpaca.liveKey;
        const secret =
          this.config.trading.mode === 'PAPER'
            ? this.config.alpaca.paperSecret
            : this.config.alpaca.liveSecret;
        socket.send(JSON.stringify({ action: 'auth', key, secret }));
      };
      const onMessage = (raw: WebSocket.RawData): void => {
        let messages: unknown;
        try {
          const bytes = Array.isArray(raw)
            ? Buffer.concat(raw)
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw)
              : raw;
          messages = JSON.parse(bytes.toString('utf8')) as unknown;
        } catch {
          this.logger.warn('Ignored malformed Alpaca stream message');
          return;
        }
        if (!Array.isArray(messages)) return;
        for (const value of messages) {
          if (
            value &&
            typeof value === 'object' &&
            (value as Record<string, unknown>).T === 'error'
          ) {
            clearTimeout(authenticationTimer);
            const rawMessage = (value as Record<string, unknown>).msg;
            const message =
              typeof rawMessage === 'string' || typeof rawMessage === 'number'
                ? String(rawMessage)
                : 'unknown error';
            reject(new Error(`ALPACA_MARKET_STREAM_ERROR: ${message}`));
            socket.close(1_008, 'authentication or subscription rejected');
            continue;
          }
          if (
            value &&
            typeof value === 'object' &&
            (value as Record<string, unknown>).T === 'success' &&
            (value as Record<string, unknown>).msg === 'authenticated'
          ) {
            socket.send(
              JSON.stringify({
                action: 'subscribe',
                bars: symbols,
                quotes: symbols,
                trades: symbols,
                statuses: symbols,
                lulds: symbols,
              }),
            );
            continue;
          }
          if (
            value &&
            typeof value === 'object' &&
            (value as Record<string, unknown>).T === 'subscription'
          ) {
            subscribed = true;
            clearTimeout(authenticationTimer);
            this.stateValue = 'SUBSCRIBED';
            for (const symbol of symbols) this.healthService.beginWarmup(symbol);
            const recoveryStart = this.disconnectedAt;
            const finish = async (): Promise<void> => {
              if (recoveryStart) await this.hooks.onRecovered?.(symbols, recoveryStart, new Date());
              this.reconnectAttempt = 0;
              this.disconnectedAt = undefined;
              resolve();
            };
            void finish().catch(reject);
            continue;
          }
          const marketEvent = parseRealtimeMarketEvent(value);
          if (marketEvent?.kind === 'BAR') void this.hooks.onBar?.(marketEvent.value);
          if (marketEvent?.kind === 'QUOTE') void this.hooks.onQuote?.(marketEvent.value);
          if (marketEvent?.kind === 'TRADE') void this.hooks.onTrade?.(marketEvent.value);
          const parsed = parseMarketStreamMessage(value);
          if (parsed?.type === 'STATUS') this.haltService.applyStatus(parsed);
          if (parsed?.type === 'LULD') this.haltService.applyLuld(parsed);
        }
      };
      const onError = (error: Error): void => {
        clearTimeout(authenticationTimer);
        reject(error);
      };
      socket.once('open', onOpen);
      socket.on('message', onMessage);
      socket.once('error', onError);
      socket.once('close', () => {
        clearTimeout(authenticationTimer);
        if (this.socket === socket) this.socket = null;
        this.disconnectedAt ??= new Date();
        if (!subscribed) reject(new Error('ALPACA_MARKET_STREAM_CLOSED_BEFORE_SUBSCRIPTION'));
        if (!this.stopped) {
          const currentSymbols = [...this.subscribedSymbols].sort();
          void this.hooks.onDisconnected?.(currentSymbols, this.disconnectedAt);
          void this.reconnect(currentSymbols);
        }
      });
    });
  }

  private async reconnect(symbols: readonly string[]): Promise<void> {
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.logger.warn(
      { reconnectAttempt: this.reconnectAttempt, delay },
      'Reconnecting Alpaca stream',
    );
    await this.sleep(delay);
    await this.connect(symbols).catch((error: unknown) => {
      this.logger.error({ err: error }, 'Alpaca stream reconnect failed');
    });
  }
}

type RealtimeMarketEvent =
  | { readonly kind: 'BAR'; readonly value: MarketBar }
  | { readonly kind: 'QUOTE'; readonly value: MarketQuote }
  | { readonly kind: 'TRADE'; readonly value: MarketTrade };

function parseRealtimeMarketEvent(input: unknown): RealtimeMarketEvent | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const symbol = typeof value.S === 'string' ? value.S : undefined;
  const timestamp = typeof value.t === 'string' ? new Date(value.t) : undefined;
  if (!symbol || !timestamp || !Number.isFinite(timestamp.getTime())) return undefined;
  const number = (key: string): number | undefined => {
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
  };
  if (value.T === 'b') {
    const open = number('o');
    const high = number('h');
    const low = number('l');
    const close = number('c');
    const volume = number('v');
    if (
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined ||
      volume === undefined
    )
      return undefined;
    const tradeCount = number('n');
    const vwap = number('vw');
    return {
      kind: 'BAR',
      value: {
        symbol,
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        ...(tradeCount === undefined ? {} : { tradeCount }),
        ...(vwap === undefined ? {} : { vwap }),
      },
    };
  }
  if (value.T === 'q') {
    const bidPrice = number('bp');
    const bidSize = number('bs');
    const askPrice = number('ap');
    const askSize = number('as');
    if (
      bidPrice === undefined ||
      bidSize === undefined ||
      askPrice === undefined ||
      askSize === undefined
    )
      return undefined;
    return {
      kind: 'QUOTE',
      value: {
        symbol,
        timestamp,
        bidPrice,
        bidSize,
        askPrice,
        askSize,
      },
    };
  }
  if (value.T === 't') {
    const price = number('p');
    const size = number('s');
    if (price === undefined || size === undefined) return undefined;
    return {
      kind: 'TRADE',
      value: {
        symbol,
        timestamp,
        price,
        size,
        id:
          typeof value.i === 'string' || typeof value.i === 'number'
            ? String(value.i)
            : `${symbol}:${timestamp.toISOString()}`,
      },
    };
  }
  return undefined;
}
