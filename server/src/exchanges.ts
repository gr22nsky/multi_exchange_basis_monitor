import { z } from 'zod';
import type { Exchange, MarketSelection } from './types.js';

const BINANCE_SPOT_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const BINANCE_SPOT_TICKERS_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const BINANCE_PERP_EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_PERP_TICKERS_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';

const OKX_INSTRUMENTS_URL = 'https://www.okx.com/api/v5/public/instruments';
const OKX_TICKERS_URL = 'https://www.okx.com/api/v5/market/tickers';

const BYBIT_INSTRUMENTS_URL = 'https://api.bybit.com/v5/market/instruments-info';
const BYBIT_TICKERS_URL = 'https://api.bybit.com/v5/market/tickers';

interface ExchangeUniverse {
  spotMarkets: Map<string, string>;
  perpMarkets: Map<string, string>;
  spotVolumes: Map<string, number>;
  perpVolumes: Map<string, number>;
}

const EXCLUDED_BASES = new Set([
  'USDT',
  'USDC',
  'BUSD',
  'FDUSD',
  'TUSD',
  'USDE',
  'DAI',
  'USDD',
  'PYUSD',
  'EURC',
]);

const binanceExchangeInfoSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.string(),
      baseAsset: z.string(),
      quoteAsset: z.string(),
      status: z.string(),
      contractType: z.string().optional(),
    }),
  ),
});

const binanceTickerSchema = z.array(
  z.object({
    symbol: z.string(),
    quoteVolume: z.string(),
  }),
);

const okxResponseSchema = z.object({
  data: z.array(z.record(z.string(), z.any())),
});

const bybitResponseSchema = z.object({
  result: z.object({
    list: z.array(z.record(z.string(), z.any())),
    nextPageCursor: z.string().optional(),
  }),
});

async function fetchJson<T>(url: string, schema: z.ZodSchema<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'multiexchange-monitor/0.1',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return schema.parse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function toPositiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function invertMarketMap(markets: Map<string, string>): Map<string, string> {
  return new Map([...markets.entries()].map(([base, symbol]) => [symbol, base]));
}

async function loadBinanceUniverse(): Promise<ExchangeUniverse> {
  const [spotInfo, spotTickers, perpInfo, perpTickers] = await Promise.all([
    fetchJson(BINANCE_SPOT_EXCHANGE_INFO_URL, binanceExchangeInfoSchema),
    fetchJson(BINANCE_SPOT_TICKERS_URL, binanceTickerSchema),
    fetchJson(BINANCE_PERP_EXCHANGE_INFO_URL, binanceExchangeInfoSchema),
    fetchJson(BINANCE_PERP_TICKERS_URL, binanceTickerSchema),
  ]);

  const spotMarkets = new Map<string, string>();
  for (const symbol of spotInfo.symbols) {
    if (symbol.quoteAsset !== 'USDT' || symbol.status !== 'TRADING') {
      continue;
    }

    spotMarkets.set(symbol.baseAsset, symbol.symbol);
  }

  const perpMarkets = new Map<string, string>();
  for (const symbol of perpInfo.symbols) {
    if (
      symbol.quoteAsset !== 'USDT' ||
      symbol.status !== 'TRADING' ||
      symbol.contractType !== 'PERPETUAL'
    ) {
      continue;
    }

    perpMarkets.set(symbol.baseAsset, symbol.symbol);
  }

  const spotBySymbol = invertMarketMap(spotMarkets);
  const perpBySymbol = invertMarketMap(perpMarkets);
  const spotVolumes = new Map<string, number>();
  const perpVolumes = new Map<string, number>();

  for (const ticker of spotTickers) {
    const base = spotBySymbol.get(ticker.symbol);
    if (base) {
      spotVolumes.set(base, toPositiveNumber(ticker.quoteVolume));
    }
  }

  for (const ticker of perpTickers) {
    const base = perpBySymbol.get(ticker.symbol);
    if (base) {
      perpVolumes.set(base, toPositiveNumber(ticker.quoteVolume));
    }
  }

  return { spotMarkets, perpMarkets, spotVolumes, perpVolumes };
}

async function loadOkxUniverse(): Promise<ExchangeUniverse> {
  const [spotInstruments, spotTickers, perpInstruments, perpTickers] = await Promise.all([
    fetchJson(`${OKX_INSTRUMENTS_URL}?instType=SPOT`, okxResponseSchema),
    fetchJson(`${OKX_TICKERS_URL}?instType=SPOT`, okxResponseSchema),
    fetchJson(`${OKX_INSTRUMENTS_URL}?instType=SWAP`, okxResponseSchema),
    fetchJson(`${OKX_TICKERS_URL}?instType=SWAP`, okxResponseSchema),
  ]);

  const spotMarkets = new Map<string, string>();
  for (const item of spotInstruments.data) {
    if (item.quoteCcy !== 'USDT' || item.state !== 'live') {
      continue;
    }

    spotMarkets.set(String(item.baseCcy), String(item.instId));
  }

  const perpMarkets = new Map<string, string>();
  for (const item of perpInstruments.data) {
    if (item.ctType !== 'linear' || item.settleCcy !== 'USDT' || item.state !== 'live') {
      continue;
    }

    perpMarkets.set(String(item.instId).split('-')[0], String(item.instId));
  }

  const spotByInstId = invertMarketMap(spotMarkets);
  const perpByInstId = invertMarketMap(perpMarkets);
  const spotVolumes = new Map<string, number>();
  const perpVolumes = new Map<string, number>();

  for (const ticker of spotTickers.data) {
    const base = spotByInstId.get(String(ticker.instId));
    if (base) {
      spotVolumes.set(base, toPositiveNumber(ticker.volCcy24h));
    }
  }

  for (const ticker of perpTickers.data) {
    const base = perpByInstId.get(String(ticker.instId));
    if (base) {
      perpVolumes.set(base, toPositiveNumber(ticker.volCcy24h));
    }
  }

  return { spotMarkets, perpMarkets, spotVolumes, perpVolumes };
}

async function fetchBybitPagedList(category: 'spot' | 'linear'): Promise<Record<string, unknown>[]> {
  const list: Record<string, unknown>[] = [];
  let cursor = '';

  while (true) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const response = await fetchJson(
      `${BYBIT_INSTRUMENTS_URL}?category=${category}&limit=1000${suffix}`,
      bybitResponseSchema,
    );

    list.push(...response.result.list);

    if (!response.result.nextPageCursor) {
      break;
    }

    cursor = response.result.nextPageCursor;
  }

  return list;
}

async function loadBybitUniverse(): Promise<ExchangeUniverse> {
  const [spotInstruments, spotTickers, perpInstruments, perpTickers] = await Promise.all([
    fetchBybitPagedList('spot'),
    fetchJson(`${BYBIT_TICKERS_URL}?category=spot`, bybitResponseSchema),
    fetchBybitPagedList('linear'),
    fetchJson(`${BYBIT_TICKERS_URL}?category=linear`, bybitResponseSchema),
  ]);

  const spotMarkets = new Map<string, string>();
  for (const item of spotInstruments) {
    if (item.quoteCoin !== 'USDT' || item.status !== 'Trading') {
      continue;
    }

    spotMarkets.set(String(item.baseCoin), String(item.symbol));
  }

  const perpMarkets = new Map<string, string>();
  for (const item of perpInstruments) {
    if (
      item.quoteCoin !== 'USDT' ||
      item.status !== 'Trading' ||
      item.contractType !== 'LinearPerpetual'
    ) {
      continue;
    }

    perpMarkets.set(String(item.baseCoin), String(item.symbol));
  }

  const spotBySymbol = invertMarketMap(spotMarkets);
  const perpBySymbol = invertMarketMap(perpMarkets);
  const spotVolumes = new Map<string, number>();
  const perpVolumes = new Map<string, number>();

  for (const ticker of spotTickers.result.list) {
    const base = spotBySymbol.get(String(ticker.symbol));
    if (base) {
      spotVolumes.set(base, toPositiveNumber(ticker.turnover24h));
    }
  }

  for (const ticker of perpTickers.result.list) {
    const base = perpBySymbol.get(String(ticker.symbol));
    if (base) {
      perpVolumes.set(base, toPositiveNumber(ticker.turnover24h));
    }
  }

  return { spotMarkets, perpMarkets, spotVolumes, perpVolumes };
}

function sumVolumes(universe: ExchangeUniverse, base: string): number {
  return universe.spotVolumes.get(base) ?? 0;
}

export async function loadSelections(limit = 10): Promise<MarketSelection[]> {
  const [binance, okx, bybit] = await Promise.all([
    loadBinanceUniverse(),
    loadOkxUniverse(),
    loadBybitUniverse(),
  ]);

  const commonBases = [...binance.spotMarkets.keys()].filter(
    (base) =>
      !EXCLUDED_BASES.has(base) &&
      binance.perpMarkets.has(base) &&
      okx.spotMarkets.has(base) &&
      okx.perpMarkets.has(base) &&
      bybit.spotMarkets.has(base) &&
      bybit.perpMarkets.has(base),
  );

  return commonBases
    .map((base) => ({
      base,
      rankingVolume:
        sumVolumes(binance, base) + sumVolumes(okx, base) + sumVolumes(bybit, base),
      markets: {
        binance: {
          spot: binance.spotMarkets.get(base)!,
          perp: binance.perpMarkets.get(base)!,
        },
        okx: {
          spot: okx.spotMarkets.get(base)!,
          perp: okx.perpMarkets.get(base)!,
        },
        bybit: {
          spot: bybit.spotMarkets.get(base)!,
          perp: bybit.perpMarkets.get(base)!,
        },
      },
    }))
    .sort((left, right) => right.rankingVolume - left.rankingVolume)
    .slice(0, limit);
}

export function getBinanceStreamPath(symbols: string[]): string {
  return symbols.map((symbol) => `${symbol.toLowerCase()}@depth5@100ms`).join('/');
}

export function buildMarketLookup(selection: MarketSelection[], exchange: Exchange): {
  spot: Map<string, string>;
  perp: Map<string, string>;
} {
  const spot = new Map<string, string>();
  const perp = new Map<string, string>();

  for (const item of selection) {
    spot.set(item.markets[exchange].spot, item.base);
    perp.set(item.markets[exchange].perp, item.base);
  }

  return { spot, perp };
}
