import { Decimal, dec, isDecimalString } from "../lib/decimal.ts";
import { msToIso } from "../lib/time.ts";
import type { OkxSite } from "../okx/public-client.ts";
import type { Instrument, ProductType } from "./instruments.ts";

/** Subsets of OKX public response rows. Field meanings follow the OKX v5 REST docs. */
export interface OkxTickerRow {
  instId: string;
  last: string;
  bidPx: string;
  askPx: string;
  open24h: string;
  high24h: string;
  low24h: string;
  vol24h: string;
  volCcy24h: string;
  ts: string;
}
export interface OkxBookRow {
  /** [price, size, deprecated, orderCount]; size is base currency for spot, contracts for perpetuals. */
  asks: string[][];
  bids: string[][];
  ts: string;
}
export interface OkxFundingRow {
  instId: string;
  fundingRate: string;
  fundingTime: string;
  nextFundingTime: string;
  ts: string;
}
export interface OkxOpenInterestRow {
  instId: string;
  oi: string;
  oiCcy: string;
  oiUsd: string;
  ts: string;
}
export interface OkxMarkPriceRow {
  instId: string;
  markPx: string;
  ts: string;
}
export interface OkxIndexTickerRow {
  instId: string;
  idxPx: string;
  ts: string;
}

/** A response row together with when it was received and which stored raw response it came from. */
export interface Sourced<T> {
  row: T;
  receivedAt: string;
  rawRef: string;
}

/** A value carrying its own exchange time, local receive time and raw-response reference. */
export interface Observed<T> {
  value: T;
  exchangeTs: string | null;
  receivedAt: string;
  rawRef: string;
}

export interface TickerFields {
  last: string;
  bid: string;
  ask: string;
  open24h: string;
  high24h: string;
  low24h: string;
  turnover24hUsdt: string;
  /** spot: volCcy24h is already USDT; perpetual: volCcy24h is base coin and is multiplied by last. */
  turnoverMethod: "spot_volCcy24h" | "perp_volCcy24h_x_last";
}

export interface DepthFields {
  /** Levels requested per side. */
  requestedLevels: number;
  /** Levels actually summed per side; fewer than requested means the book is that thin. */
  bidLevels: number;
  askLevels: number;
  bidNotionalUsdt: string;
  askNotionalUsdt: string;
}

export interface DerivativeFields {
  funding: Observed<{ rate: string; fundingTime: string | null; nextFundingTime: string | null }> | null;
  openInterest: Observed<{ contracts: string; baseCcy: string; usd: string }> | null;
  markPx: Observed<string> | null;
  indexPx: Observed<string> | null;
}

export interface MarketSnapshot {
  source: "okx_public_rest";
  site: OkxSite;
  instId: string;
  product: ProductType;
  instrument: Instrument;
  ticker: Observed<TickerFields> | null;
  depth: Observed<DepthFields> | null;
  /** Spot has no derivative fields: they are "not_applicable", never zero. */
  derivatives: DerivativeFields | "not_applicable";
  /** Applicable groups that are absent ("<group>:missing") or unusable ("<group>:incomplete"). */
  gaps: string[];
}

export interface SnapshotSources {
  ticker?: Sourced<OkxTickerRow>;
  book?: Sourced<OkxBookRow>;
  funding?: Sourced<OkxFundingRow>;
  openInterest?: Sourced<OkxOpenInterestRow>;
  markPrice?: Sourced<OkxMarkPriceRow>;
  indexTicker?: Sourced<OkxIndexTickerRow>;
}

export function buildSnapshot(site: OkxSite, instrument: Instrument, sources: SnapshotSources, depthLevels: number): MarketSnapshot {
  const gaps: string[] = [];
  const ticker = observeGroup("ticker", sources.ticker, gaps, (row) => tickerFields(instrument, row));
  const depth = observeGroup("depth", sources.book, gaps, (row) => depthFields(instrument, row, depthLevels));
  let derivatives: MarketSnapshot["derivatives"] = "not_applicable";
  if (instrument.product === "usdt_perpetual") {
    derivatives = {
      funding: observeGroup("funding", sources.funding, gaps, (row) =>
        isDecimalString(row.fundingRate)
          ? { rate: row.fundingRate, fundingTime: msToIso(row.fundingTime), nextFundingTime: msToIso(row.nextFundingTime) }
          : null,
      ),
      openInterest: observeGroup("openInterest", sources.openInterest, gaps, (row) =>
        allDecimal(row.oi, row.oiCcy, row.oiUsd) ? { contracts: row.oi, baseCcy: row.oiCcy, usd: row.oiUsd } : null,
      ),
      markPx: observeGroup("markPx", sources.markPrice, gaps, (row) => (isDecimalString(row.markPx) ? row.markPx : null)),
      indexPx: observeGroup("indexPx", sources.indexTicker, gaps, (row) => (isDecimalString(row.idxPx) ? row.idxPx : null)),
    };
  }
  return { source: "okx_public_rest", site, instId: instrument.instId, product: instrument.product, instrument, ticker, depth, derivatives, gaps };
}

export function tickerFields(instrument: Instrument, row: OkxTickerRow): TickerFields | null {
  if (!allDecimal(row.last, row.bidPx, row.askPx, row.open24h, row.high24h, row.low24h, row.volCcy24h)) return null;
  const isSpot = instrument.product === "spot";
  const turnover = isSpot ? dec(row.volCcy24h) : dec(row.volCcy24h).mul(dec(row.last));
  return {
    last: row.last,
    bid: row.bidPx,
    ask: row.askPx,
    open24h: row.open24h,
    high24h: row.high24h,
    low24h: row.low24h,
    turnover24hUsdt: turnover.toFixed(),
    turnoverMethod: isSpot ? "spot_volCcy24h" : "perp_volCcy24h_x_last",
  };
}

function depthFields(instrument: Instrument, row: OkxBookRow, requestedLevels: number): DepthFields | null {
  const bid = sideNotional(instrument, row.bids, requestedLevels);
  const ask = sideNotional(instrument, row.asks, requestedLevels);
  if (bid === null || ask === null) return null;
  return {
    requestedLevels,
    bidLevels: bid.levels,
    askLevels: ask.levels,
    bidNotionalUsdt: bid.notional.toFixed(),
    askNotionalUsdt: ask.notional.toFixed(),
  };
}

/**
 * Sum of price × size over the top levels, with the number of levels actually summed.
 * Perpetual sizes are contracts and are converted with ctVal. An empty side or a malformed level is null.
 */
function sideNotional(instrument: Instrument, entries: string[][], requestedLevels: number): { notional: Decimal; levels: number } | null {
  const top = entries.slice(0, requestedLevels);
  if (top.length === 0) return null;
  const contractValue = instrument.ctVal === null ? new Decimal(1) : dec(instrument.ctVal);
  let notional = new Decimal(0);
  for (const [px, sz] of top) {
    if (px === undefined || sz === undefined || !allDecimal(px, sz)) return null;
    notional = notional.add(dec(px).mul(dec(sz)).mul(contractValue));
  }
  return { notional, levels: top.length };
}

function observeGroup<R extends { ts: string }, V>(
  group: string,
  source: Sourced<R> | undefined,
  gaps: string[],
  map: (row: R) => V | null,
): Observed<V> | null {
  if (!source) {
    gaps.push(`${group}:missing`);
    return null;
  }
  const value = map(source.row);
  if (value === null) {
    gaps.push(`${group}:incomplete`);
    return null;
  }
  return { value, exchangeTs: msToIso(source.row.ts), receivedAt: source.receivedAt, rawRef: source.rawRef };
}

function allDecimal(...values: string[]): boolean {
  return values.every(isDecimalString);
}
