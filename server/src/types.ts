export const EXCHANGES = ['binance', 'okx', 'bybit'] as const;
export type Exchange = (typeof EXCHANGES)[number];
export type MarketKind = 'spot' | 'perp';
export type ConnectionStatus = 'connected' | 'disconnected';

export interface Quote {
  bid: number;
  ask: number;
  mid: number;
  ts: number;
}

export interface MarketPair {
  spot: string;
  perp: string;
}

export interface MarketSelection {
  base: string;
  rankingVolume: number;
  markets: Record<Exchange, MarketPair>;
}

export interface QuoteSummary {
  exchange: Exchange;
  mid: number;
  ts: number;
}

export interface CoinSnapshot {
  base: string;
  rankingVolume: number;
  exchanges: Record<Exchange, { spot: Quote | null; perp: Quote | null }>;
  bestSpot: QuoteSummary | null;
  bestPerp: QuoteSummary | null;
  premiumPct: number | null;
  ready: boolean;
}

export interface DashboardSnapshot {
  coins: CoinSnapshot[];
  leader: CoinSnapshot | null;
  updatedAt: number;
  staleAfterMs: number;
  streamHealth: Record<Exchange, Record<MarketKind, ConnectionStatus>>;
  exchangeLatencyMs: Record<Exchange, number | null>;
}
