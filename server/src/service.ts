import WebSocket from 'ws';
import { buildMarketLookup, getBinanceStreamPath, loadSelections } from './exchanges.js';
import {
  EXCHANGES,
  type CoinSnapshot,
  type ConnectionStatus,
  type DashboardSnapshot,
  type Exchange,
  type MarketKind,
  type MarketSelection,
  type Quote,
} from './types.js';

type ExchangeQuoteStore = Record<Exchange, { spot: Quote | null; perp: Quote | null }>;

const STALE_AFTER_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;

function emptyExchangeQuoteStore(): ExchangeQuoteStore {
  return {
    binance: { spot: null, perp: null },
    okx: { spot: null, perp: null },
    bybit: { spot: null, perp: null },
  };
}

function createHealthMap(): Record<Exchange, Record<MarketKind, ConnectionStatus>> {
  return {
    binance: { spot: 'disconnected', perp: 'disconnected' },
    okx: { spot: 'disconnected', perp: 'disconnected' },
    bybit: { spot: 'disconnected', perp: 'disconnected' },
  };
}

function closeSocket(socket?: WebSocket): void {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    return;
  }

  socket.removeAllListeners();
  socket.close();
}

export class MarketMonitorService {
  private selection: MarketSelection[] = [];
  private quotes = new Map<string, ExchangeQuoteStore>();
  private streamHealth = createHealthMap();
  private sockets: Partial<Record<`${Exchange}:${MarketKind}`, WebSocket>> = {};
  private pingTimers: NodeJS.Timeout[] = [];
  private refreshTimer?: NodeJS.Timeout;

  async start(): Promise<void> {
    await this.reloadSelection();
    this.refreshTimer = setInterval(() => {
      void this.reloadSelection();
    }, 30 * 60 * 1000);
    this.refreshTimer.unref();
  }

  stop(): void {
    for (const socket of Object.values(this.sockets)) {
      closeSocket(socket);
    }

    for (const timer of this.pingTimers) {
      clearInterval(timer);
    }

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  getSnapshot(): DashboardSnapshot {
    const coins = this.selection.map((item) => this.buildCoinSnapshot(item));
    const leader =
      [...coins]
        .filter((coin) => coin.premiumPct !== null)
        .sort((left, right) => (right.premiumPct ?? -Infinity) - (left.premiumPct ?? -Infinity))[0] ??
      null;

    return {
      coins,
      leader,
      updatedAt: Date.now(),
      staleAfterMs: STALE_AFTER_MS,
      streamHealth: this.streamHealth,
      exchangeLatencyMs: this.buildExchangeLatencyMap(),
    };
  }

  private buildExchangeLatencyMap(): Record<Exchange, number | null> {
    const now = Date.now();

    return {
      binance: this.getExchangeLatencyMs('binance', now),
      okx: this.getExchangeLatencyMs('okx', now),
      bybit: this.getExchangeLatencyMs('bybit', now),
    };
  }

  private getExchangeLatencyMs(exchange: Exchange, now: number): number | null {
    let latestTs = 0;

    for (const quotes of this.quotes.values()) {
      const spotTs = quotes[exchange].spot?.ts ?? 0;
      const perpTs = quotes[exchange].perp?.ts ?? 0;
      latestTs = Math.max(latestTs, spotTs, perpTs);
    }

    return latestTs > 0 ? Math.max(0, now - latestTs) : null;
  }

  private async reloadSelection(): Promise<void> {
    const nextSelection = await loadSelections(10);
    this.selection = nextSelection;
    this.quotes = new Map(nextSelection.map((item) => [item.base, emptyExchangeQuoteStore()]));
    this.reconnectAll();
  }

  private reconnectAll(): void {
    for (const socket of Object.values(this.sockets)) {
      closeSocket(socket);
    }

    for (const timer of this.pingTimers) {
      clearInterval(timer);
    }

    this.sockets = {};
    this.pingTimers = [];
    this.streamHealth = createHealthMap();

    if (this.selection.length === 0) {
      return;
    }

    this.connectBinance('spot');
    this.connectBinance('perp');
    this.connectOkx();
    this.connectBybit('spot');
    this.connectBybit('perp');
  }

  private buildCoinSnapshot(item: MarketSelection): CoinSnapshot {
    const exchangeQuotes = this.quotes.get(item.base) ?? emptyExchangeQuoteStore();
    const activeSpotQuotes = this.collectActiveQuotes(exchangeQuotes, 'spot');
    const activePerpQuotes = this.collectActiveQuotes(exchangeQuotes, 'perp');

    const bestSpot = activeSpotQuotes.sort((left, right) => left.mid - right.mid)[0] ?? null;
    const bestPerp = activePerpQuotes.sort((left, right) => right.mid - left.mid)[0] ?? null;
    const premiumPct =
      bestSpot && bestPerp
        ? ((bestPerp.mid - bestSpot.mid) / bestSpot.mid) * 100
        : null;

    return {
      base: item.base,
      rankingVolume: item.rankingVolume,
      exchanges: exchangeQuotes,
      bestSpot,
      bestPerp,
      premiumPct,
      ready: Boolean(bestSpot && bestPerp),
    };
  }

  private collectActiveQuotes(
    quotes: ExchangeQuoteStore,
    kind: MarketKind,
  ): Array<{ exchange: Exchange; mid: number; ts: number }> {
    const now = Date.now();
    const result: Array<{ exchange: Exchange; mid: number; ts: number }> = [];

    for (const exchange of EXCHANGES) {
      const quote = quotes[exchange][kind];
      if (!quote || now - quote.ts > STALE_AFTER_MS) {
        continue;
      }

      result.push({ exchange, mid: quote.mid, ts: quote.ts });
    }

    return result;
  }

  private setHealth(exchange: Exchange, kind: MarketKind, status: ConnectionStatus): void {
    this.streamHealth[exchange][kind] = status;
  }

  private upsertQuote(
    base: string,
    exchange: Exchange,
    kind: MarketKind,
    bid: string | number,
    ask: string | number,
    ts = Date.now(),
  ): void {
    const bidValue = Number(bid);
    const askValue = Number(ask);

    if (!Number.isFinite(bidValue) || !Number.isFinite(askValue) || bidValue <= 0 || askValue <= 0) {
      return;
    }

    const coinQuotes = this.quotes.get(base);
    if (!coinQuotes) {
      return;
    }

    coinQuotes[exchange][kind] = {
      bid: bidValue,
      ask: askValue,
      mid: (bidValue + askValue) / 2,
      ts,
    };
  }

  private connectBinance(kind: MarketKind): void {
    const exchange = 'binance';
    const lookup = buildMarketLookup(this.selection, exchange);
    const symbols = [...lookup[kind].keys()];
    const endpoint =
      kind === 'spot'
        ? `wss://stream.binance.com:9443/stream?streams=${getBinanceStreamPath(symbols)}`
        : `wss://fstream.binance.com/stream?streams=${getBinanceStreamPath(symbols)}`;
    const key: `${Exchange}:${MarketKind}` = `${exchange}:${kind}`;

    const socket = new WebSocket(endpoint);
    this.sockets[key] = socket;

    socket.on('open', () => this.setHealth(exchange, kind, 'connected'));
    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(String(raw)) as {
          stream?: string;
          data?: {
            bids?: [string, string][];
            asks?: [string, string][];
            b?: [string, string][];
            a?: [string, string][];
          };
        };

        const stream = payload.stream?.split('@')[0].toUpperCase();
        const bestBid = payload.data?.bids?.[0]?.[0] ?? payload.data?.b?.[0]?.[0];
        const bestAsk = payload.data?.asks?.[0]?.[0] ?? payload.data?.a?.[0]?.[0];
        const base = stream ? lookup[kind].get(stream) : undefined;

        if (base && bestBid && bestAsk) {
          this.upsertQuote(base, exchange, kind, bestBid, bestAsk);
        }
      } catch (error) {
        console.error(`binance ${kind} parse error`, error);
      }
    });

    socket.on('close', () => {
      this.setHealth(exchange, kind, 'disconnected');
      setTimeout(() => this.connectBinance(kind), RECONNECT_DELAY_MS).unref();
    });

    socket.on('error', (error) => {
      this.setHealth(exchange, kind, 'disconnected');
      console.error(`binance ${kind} websocket error`, error);
      closeSocket(socket);
    });
  }

  private connectOkx(): void {
    const exchange = 'okx';
    const lookup = buildMarketLookup(this.selection, exchange);
    const socket = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');

    this.sockets['okx:spot'] = socket;
    this.sockets['okx:perp'] = socket;

    socket.on('open', () => {
      this.setHealth(exchange, 'spot', 'connected');
      this.setHealth(exchange, 'perp', 'connected');
      socket.send(
        JSON.stringify({
          op: 'subscribe',
          args: [
            ...[...lookup.spot.keys()].map((instId) => ({ channel: 'books5', instId })),
            ...[...lookup.perp.keys()].map((instId) => ({ channel: 'books5', instId })),
          ],
        }),
      );

      const timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send('ping');
        }
      }, 20_000);
      timer.unref();
      this.pingTimers.push(timer);
    });

    socket.on('message', (raw) => {
      const text = String(raw);
      if (text === 'pong') {
        return;
      }

      try {
        const payload = JSON.parse(text) as {
          arg?: { instId?: string };
          data?: Array<{ asks?: [string, string, string, string][]; bids?: [string, string, string, string][]; ts?: string }>;
          event?: string;
        };

        if (payload.event) {
          return;
        }

        const instId = payload.arg?.instId;
        const book = payload.data?.[0];
        const bestBid = book?.bids?.[0]?.[0];
        const bestAsk = book?.asks?.[0]?.[0];
        const ts = Number(book?.ts ?? Date.now());

        if (!instId || !bestBid || !bestAsk) {
          return;
        }

        const spotBase = lookup.spot.get(instId);
        if (spotBase) {
          this.upsertQuote(spotBase, exchange, 'spot', bestBid, bestAsk, ts);
          return;
        }

        const perpBase = lookup.perp.get(instId);
        if (perpBase) {
          this.upsertQuote(perpBase, exchange, 'perp', bestBid, bestAsk, ts);
        }
      } catch (error) {
        console.error('okx parse error', error);
      }
    });

    socket.on('close', () => {
      this.setHealth(exchange, 'spot', 'disconnected');
      this.setHealth(exchange, 'perp', 'disconnected');
      setTimeout(() => this.connectOkx(), RECONNECT_DELAY_MS).unref();
    });

    socket.on('error', (error) => {
      this.setHealth(exchange, 'spot', 'disconnected');
      this.setHealth(exchange, 'perp', 'disconnected');
      console.error('okx websocket error', error);
      closeSocket(socket);
    });
  }

  private connectBybit(kind: MarketKind): void {
    const exchange = 'bybit';
    const lookup = buildMarketLookup(this.selection, exchange);
    const topics = [...lookup[kind].keys()].map((symbol) => `orderbook.1.${symbol}`);
    const endpoint =
      kind === 'spot'
        ? 'wss://stream.bybit.com/v5/public/spot'
        : 'wss://stream.bybit.com/v5/public/linear';
    const key: `${Exchange}:${MarketKind}` = `${exchange}:${kind}`;
    const socket = new WebSocket(endpoint);

    this.sockets[key] = socket;

    socket.on('open', () => {
      this.setHealth(exchange, kind, 'connected');
      socket.send(JSON.stringify({ op: 'subscribe', args: topics }));

      const timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: 'ping' }));
        }
      }, 20_000);
      timer.unref();
      this.pingTimers.push(timer);
    });

    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(String(raw)) as {
          op?: string;
          topic?: string;
          ts?: number;
          data?: {
            s?: string;
            b?: [string, string][];
            a?: [string, string][];
          };
          ret_msg?: string;
        };

        if (payload.op || payload.ret_msg === 'pong') {
          return;
        }

        const symbol = payload.data?.s ?? payload.topic?.split('.').at(-1);
        const bestBid = payload.data?.b?.[0]?.[0];
        const bestAsk = payload.data?.a?.[0]?.[0];
        const base = symbol ? lookup[kind].get(symbol) : undefined;

        if (base && bestBid && bestAsk) {
          this.upsertQuote(base, exchange, kind, bestBid, bestAsk, payload.ts ?? Date.now());
        }
      } catch (error) {
        console.error(`bybit ${kind} parse error`, error);
      }
    });

    socket.on('close', () => {
      this.setHealth(exchange, kind, 'disconnected');
      setTimeout(() => this.connectBybit(kind), RECONNECT_DELAY_MS).unref();
    });

    socket.on('error', (error) => {
      this.setHealth(exchange, kind, 'disconnected');
      console.error(`bybit ${kind} websocket error`, error);
      closeSocket(socket);
    });
  }
}
