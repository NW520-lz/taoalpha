// A01: real OKX public market data, no credentials. Requires network; run with `npm run test:live`.
// A network failure fails the test with the recorded error; it is never treated as empty data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, type PublicResult } from "../src/okx/public-client.ts";
import { parseInstruments, type OkxInstrumentRow } from "../src/market/instruments.ts";
import {
  buildSnapshot,
  type OkxBookRow,
  type OkxFundingRow,
  type OkxIndexTickerRow,
  type OkxMarkPriceRow,
  type OkxOpenInterestRow,
  type OkxTickerRow,
  type Sourced,
} from "../src/market/snapshot.ts";

const client = createPublicClient();
const FIVE_MINUTES_MS = 5 * 60 * 1000;

async function first<T>(path: string, query: Record<string, string>): Promise<Sourced<T>> {
  const result: PublicResult<T> = await client.get<T>(path, query);
  assert.ok(result.ok, `${path} failed: ${JSON.stringify(result.ok ? null : result.error)}`);
  const [row] = result.rows;
  assert.ok(row, `${result.endpoint} returned no rows`);
  console.log(`source ${result.endpoint} receivedAt ${result.raw.receivedAt}`);
  return { row, receivedAt: result.raw.receivedAt, rawRef: result.endpoint };
}

function assertFresh(exchangeTs: string | null | undefined, label: string): void {
  assert.ok(exchangeTs, `${label} has no exchange time`);
  assert.ok(Math.abs(Date.now() - Date.parse(exchangeTs)) < FIVE_MINUTES_MS, `${label} exchange time ${exchangeTs} is not recent`);
}

test("A01: BTC-USDT spot snapshot from real public data", async () => {
  const inst = await first<OkxInstrumentRow>("/api/v5/public/instruments", { instType: "SPOT", instId: "BTC-USDT" });
  const [instrument] = parseInstruments([inst.row]);
  assert.ok(instrument);
  const snap = buildSnapshot("global", instrument, {
    ticker: await first<OkxTickerRow>("/api/v5/market/ticker", { instId: "BTC-USDT" }),
    book: await first<OkxBookRow>("/api/v5/market/books", { instId: "BTC-USDT", sz: "5" }),
  }, 5);
  console.log(JSON.stringify(snap, null, 2));
  assert.equal(snap.product, "spot");
  assert.deepEqual(snap.gaps, []);
  assert.equal(snap.derivatives, "not_applicable");
  assert.match(snap.ticker?.value.turnover24hUsdt ?? "", /^\d+(\.\d+)?$/);
  assertFresh(snap.ticker?.exchangeTs, "spot ticker");
  assertFresh(snap.depth?.exchangeTs, "spot book");
});

test("A01: BTC-USDT-SWAP snapshot from real public data keeps perpetual units and fields", async () => {
  const inst = await first<OkxInstrumentRow>("/api/v5/public/instruments", { instType: "SWAP", instId: "BTC-USDT-SWAP" });
  const [instrument] = parseInstruments([inst.row]);
  assert.ok(instrument);
  assert.equal(instrument.product, "usdt_perpetual");
  assert.match(instrument.ctVal ?? "", /^\d+(\.\d+)?$/);
  const snap = buildSnapshot("global", instrument, {
    ticker: await first<OkxTickerRow>("/api/v5/market/ticker", { instId: "BTC-USDT-SWAP" }),
    book: await first<OkxBookRow>("/api/v5/market/books", { instId: "BTC-USDT-SWAP", sz: "5" }),
    funding: await first<OkxFundingRow>("/api/v5/public/funding-rate", { instId: "BTC-USDT-SWAP" }),
    openInterest: await first<OkxOpenInterestRow>("/api/v5/public/open-interest", { instType: "SWAP", instId: "BTC-USDT-SWAP" }),
    markPrice: await first<OkxMarkPriceRow>("/api/v5/public/mark-price", { instType: "SWAP", instId: "BTC-USDT-SWAP" }),
    indexTicker: await first<OkxIndexTickerRow>("/api/v5/market/index-tickers", { instId: "BTC-USDT" }),
  }, 5);
  console.log(JSON.stringify(snap, null, 2));
  assert.deepEqual(snap.gaps, []);
  assert.equal(snap.ticker?.value.turnoverMethod, "perp_volCcy24h_x_last");
  assert.ok(snap.derivatives !== "not_applicable");
  assert.ok(snap.derivatives.funding && snap.derivatives.markPx && snap.derivatives.indexPx && snap.derivatives.openInterest);
  assertFresh(snap.ticker?.exchangeTs, "perp ticker");
  assertFresh(snap.derivatives.markPx.exchangeTs, "mark price");
});
