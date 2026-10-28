import { test } from "node:test";
import assert from "node:assert/strict";
import type { Instrument } from "../../src/market/instruments.ts";
import {
  buildSnapshot,
  type OkxBookRow,
  type OkxFundingRow,
  type OkxIndexTickerRow,
  type OkxMarkPriceRow,
  type OkxOpenInterestRow,
  type OkxTickerRow,
  type Sourced,
} from "../../src/market/snapshot.ts";

// Public OKX market values captured 2026-10-28, used as fixed fixtures.
const SPOT: Instrument = {
  instId: "BTC-USDT",
  product: "spot",
  baseCcy: "BTC",
  quoteCcy: "USDT",
  state: "live",
  listTime: "2021-01-29T08:08:06.000Z",
  tickSz: "0.1",
  lotSz: "0.00000001",
  minSz: "0.00001",
  ctVal: null,
};
const PERP: Instrument = {
  instId: "BTC-USDT-SWAP",
  product: "usdt_perpetual",
  baseCcy: "BTC",
  quoteCcy: "USDT",
  state: "live",
  listTime: "2019-11-12T11:16:48.000Z",
  tickSz: "0.1",
  lotSz: "0.01",
  minSz: "0.01",
  ctVal: "0.01",
};
const TS = "1793188799000"; // 2026-10-28T11:59:59.000Z
const T_TICKER = "2026-10-28T12:00:00.100Z";
const T_BOOK = "2026-10-28T12:00:00.200Z";

function sourced<T>(row: T, receivedAt: string, rawRef: string): Sourced<T> {
  return { row, receivedAt, rawRef };
}

const spotTicker: OkxTickerRow = {
  instId: "BTC-USDT",
  last: "80615.1",
  bidPx: "80614.5",
  askPx: "80614.6",
  open24h: "80255.2",
  high24h: "81820",
  low24h: "80208.2",
  vol24h: "4510.79898563",
  volCcy24h: "365035696.193301184",
  ts: TS,
};
const spotBook: OkxBookRow = {
  asks: [["80614.6", "3.63356261", "0", "5"], ["80614.7", "0.1", "0", "1"], ["80615", "9", "0", "1"]],
  bids: [["80614.5", "0.0600396", "0", "2"], ["80614.4", "1", "0", "3"], ["80614", "9", "0", "1"]],
  ts: "1793188799500",
};
const perpTicker: OkxTickerRow = {
  instId: "BTC-USDT-SWAP",
  last: "80580.1",
  bidPx: "80580",
  askPx: "80580.1",
  open24h: "80220",
  high24h: "81786.9",
  low24h: "80203.5",
  vol24h: "5987877.7",
  volCcy24h: "59878.777",
  ts: TS,
};
const perpBook: OkxBookRow = {
  asks: [["80580.1", "870.61", "0", "21"], ["80580.2", "0.01", "0", "1"]],
  bids: [["80580", "1478.63", "0", "57"], ["80579.9", "1.5", "0", "6"]],
  ts: TS,
};
const funding: OkxFundingRow = {
  instId: "BTC-USDT-SWAP",
  fundingRate: "0.0000613610007354",
  fundingTime: "1793203200000",
  nextFundingTime: "1793232000000",
  ts: TS,
};
const openInterest: OkxOpenInterestRow = {
  instId: "BTC-USDT-SWAP",
  oi: "3116121.98000001169",
  oiCcy: "31161.2198000001169",
  oiUsd: "2510974207.60598941981369",
  ts: TS,
};
const markPrice: OkxMarkPriceRow = { instId: "BTC-USDT-SWAP", markPx: "80579", ts: TS };
const indexTicker: OkxIndexTickerRow = { instId: "BTC-USDT", idxPx: "80611.5", ts: TS };

function perpSources() {
  return {
    ticker: sourced(perpTicker, T_TICKER, "raw_t"),
    book: sourced(perpBook, T_BOOK, "raw_b"),
    funding: sourced(funding, T_TICKER, "raw_f"),
    openInterest: sourced(openInterest, T_TICKER, "raw_oi"),
    markPrice: sourced(markPrice, T_TICKER, "raw_m"),
    indexTicker: sourced(indexTicker, T_TICKER, "raw_i"),
  };
}

test("spot: turnover is volCcy24h in USDT, depth is price × base size, derivatives are not applicable", () => {
  const snap = buildSnapshot("global", SPOT, { ticker: sourced(spotTicker, T_TICKER, "raw_t"), book: sourced(spotBook, T_BOOK, "raw_b") }, 2);
  assert.equal(snap.source, "okx_public_rest");
  assert.equal(snap.site, "global");
  assert.equal(snap.ticker?.value.turnover24hUsdt, "365035696.193301184");
  assert.equal(snap.ticker?.value.turnoverMethod, "spot_volCcy24h");
  assert.deepEqual(snap.depth?.value, { levels: 2, bidNotionalUsdt: "85454.4623342", askNotionalUsdt: "300979.666380106" });
  assert.equal(snap.derivatives, "not_applicable");
  assert.deepEqual(snap.gaps, []);
});

test("each field group keeps its own exchange time, receive time and raw reference", () => {
  const snap = buildSnapshot("global", SPOT, { ticker: sourced(spotTicker, T_TICKER, "raw_t"), book: sourced(spotBook, T_BOOK, "raw_b") }, 2);
  assert.deepEqual(
    { exchangeTs: snap.ticker?.exchangeTs, receivedAt: snap.ticker?.receivedAt, rawRef: snap.ticker?.rawRef },
    { exchangeTs: "2026-10-28T11:59:59.000Z", receivedAt: T_TICKER, rawRef: "raw_t" },
  );
  assert.deepEqual(
    { exchangeTs: snap.depth?.exchangeTs, receivedAt: snap.depth?.receivedAt, rawRef: snap.depth?.rawRef },
    { exchangeTs: "2026-10-28T11:59:59.500Z", receivedAt: T_BOOK, rawRef: "raw_b" },
  );
});

test("perpetual: turnover converts base-coin volume with last price, depth converts contracts with ctVal", () => {
  const snap = buildSnapshot("global", PERP, perpSources(), 2);
  assert.equal(snap.ticker?.value.turnover24hUsdt, "4825037838.5377");
  assert.equal(snap.ticker?.value.turnoverMethod, "perp_volCcy24h_x_last");
  assert.deepEqual(snap.depth?.value, { levels: 2, bidNotionalUsdt: "1192688.7525", askNotionalUsdt: "701546.46663" });
  assert.ok(snap.derivatives !== "not_applicable");
  assert.deepEqual(snap.derivatives.funding?.value, {
    rate: "0.0000613610007354",
    fundingTime: "2026-10-28T16:00:00.000Z",
    nextFundingTime: "2026-10-29T00:00:00.000Z",
  });
  assert.deepEqual(snap.derivatives.openInterest?.value, {
    contracts: "3116121.98000001169",
    baseCcy: "31161.2198000001169",
    usd: "2510974207.60598941981369",
  });
  assert.equal(snap.derivatives.markPx?.value, "80579");
  assert.equal(snap.derivatives.indexPx?.value, "80611.5");
  assert.deepEqual(snap.gaps, []);
});

test("perpetual: a missing funding response is a gap, never a zero rate", () => {
  const { funding: _omitted, ...withoutFunding } = perpSources();
  const snap = buildSnapshot("global", PERP, withoutFunding, 2);
  assert.ok(snap.derivatives !== "not_applicable");
  assert.equal(snap.derivatives.funding, null);
  assert.deepEqual(snap.gaps, ["funding:missing"]);
});

test("a ticker with an empty bid is unusable and recorded as incomplete", () => {
  const snap = buildSnapshot("global", SPOT, { ticker: sourced({ ...spotTicker, bidPx: "" }, T_TICKER, "raw_t"), book: sourced(spotBook, T_BOOK, "raw_b") }, 2);
  assert.equal(snap.ticker, null);
  assert.deepEqual(snap.gaps, ["ticker:incomplete"]);
});

test("a missing book is a depth gap", () => {
  const snap = buildSnapshot("global", SPOT, { ticker: sourced(spotTicker, T_TICKER, "raw_t") }, 2);
  assert.equal(snap.depth, null);
  assert.deepEqual(snap.gaps, ["depth:missing"]);
});
