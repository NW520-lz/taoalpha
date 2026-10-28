import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/store/db.ts";
import { getBundle, getEvidence } from "../../src/store/evidence-store.ts";
import { hashJson } from "../../src/lib/hash.ts";
import { runScan, screenSnapshot, type ScanCandidate } from "../../src/scan/scan.ts";
import { buildSnapshot } from "../../src/market/snapshot.ts";
import type { Instrument } from "../../src/market/instruments.ts";
import type { MarketSnapshot } from "../../src/market/snapshot.ts";
import { createFakeClient } from "../helpers/fake-okx.ts";
import { FRESH_TS, NOW, marketRoutes, testStrategy } from "../helpers/market-fixtures.ts";

const now = () => NOW;

function byId(candidates: ScanCandidate[], instId: string): ScanCandidate {
  const found = candidates.find((c) => c.instId === instId);
  assert.ok(found, `candidate ${instId} missing`);
  return found;
}

test("applies screening to live instruments only and ranks passing candidates first", async () => {
  const db = openDb(":memory:");
  const { client } = createFakeClient(marketRoutes());
  const result = await runScan(db, client, testStrategy(), now);

  assert.equal(result.screening, "applied");
  assert.deepEqual(result.candidates.map((c) => c.instId), ["GOOD-USDT", "GOOD-USDT-SWAP", "WIDE-USDT"]);
  assert.deepEqual(result.products, [
    { product: "spot", status: "ok", liveInstruments: 2, missingTicker: 0, shortlisted: 2 },
    { product: "usdt_perpetual", status: "ok", liveInstruments: 1, missingTicker: 0, shortlisted: 1 },
  ]);
  const good = byId(result.candidates, "GOOD-USDT");
  assert.deepEqual(
    { turnover: good.turnover24hUsdt, change: good.change24hPct, spread: good.spreadBps },
    { turnover: "10000000", change: "11.1111", spread: "2" },
  );
  assert.ok(good.screening.state === "applied" && good.screening.passed);
  const wide = byId(result.candidates, "WIDE-USDT");
  assert.ok(wide.screening.state === "applied" && !wide.screening.passed);
  assert.deepEqual(wide.screening.checks.filter((c) => !c.pass).map((c) => ({ rule: c.rule, actual: c.actual })), [{ rule: "spread", actual: "2000" }]);
  assert.deepEqual(result.sourceErrors, []);
});

test("stores each snapshot as evidence and freezes the bundle under its content hash", async () => {
  const db = openDb(":memory:");
  const { client } = createFakeClient(marketRoutes());
  const result = await runScan(db, client, testStrategy(), now);
  const { bundleId, bundleSha256, ...content } = result;
  assert.equal(bundleSha256, hashJson(content));
  assert.deepEqual(getBundle(db, bundleId)?.content, content);
  const evidence = getEvidence(db, byId(result.candidates, "GOOD-USDT").snapshotEvidenceId);
  assert.equal(evidence?.kind, "market_snapshot");
  assert.equal(evidence?.label, "fact");
  assert.equal((evidence?.content as MarketSnapshot).instId, "GOOD-USDT");
});

test("perpetual snapshots keep derivative fields and convert book contracts with ctVal", async () => {
  const db = openDb(":memory:");
  const { client } = createFakeClient(marketRoutes());
  const result = await runScan(db, client, testStrategy(), now);
  const snapshot = getEvidence(db, byId(result.candidates, "GOOD-USDT-SWAP").snapshotEvidenceId)?.content as MarketSnapshot;
  assert.equal(snapshot.ticker?.value.turnover24hUsdt, "10000000");
  assert.equal(snapshot.depth?.value.bidNotionalUsdt, "30000");
  assert.ok(snapshot.derivatives !== "not_applicable");
  assert.equal(snapshot.derivatives.funding?.value.rate, "0.0001");
  assert.equal(snapshot.derivatives.indexPx?.value, "10");
  assert.deepEqual(snapshot.gaps, []);
});

test("without screening thresholds, candidates are unscreened and ranked by absolute 24h change", async () => {
  const db = openDb(":memory:");
  const { client } = createFakeClient(marketRoutes());
  const result = await runScan(db, client, testStrategy({ screening: null }), now);
  assert.equal(result.screening, "not_configured");
  assert.deepEqual(result.candidates.map((c) => c.instId), ["WIDE-USDT", "GOOD-USDT", "GOOD-USDT-SWAP"]);
  assert.ok(result.candidates.every((c) => c.screening.state === "not_configured"));
});

test("a failed SWAP tickers request marks perpetuals unavailable and records the error", async () => {
  const db = openDb(":memory:");
  const routes = marketRoutes();
  routes["/api/v5/market/tickers?instType=SWAP"] = { error: { kind: "network", message: "socket hang up" } };
  const { client } = createFakeClient(routes);
  const result = await runScan(db, client, testStrategy(), now);
  assert.deepEqual(result.products[1], { product: "usdt_perpetual", status: "unavailable", liveInstruments: 0, missingTicker: 0, shortlisted: 0 });
  assert.deepEqual(result.sourceErrors, [{ endpoint: "/api/v5/market/tickers?instType=SWAP", error: { kind: "network", message: "socket hang up" } }]);
  assert.deepEqual(result.candidates.map((c) => c.instId), ["GOOD-USDT", "WIDE-USDT"]);
});

test("a failed funding request is a data gap that fails screening, never a zero rate", async () => {
  const db = openDb(":memory:");
  const routes = marketRoutes();
  delete routes["/api/v5/public/funding-rate?instId=ANY"];
  const { client } = createFakeClient(routes);
  const result = await runScan(db, client, testStrategy(), now);
  const perp = byId(result.candidates, "GOOD-USDT-SWAP");
  assert.ok(perp.screening.state === "applied" && !perp.screening.passed);
  assert.deepEqual(perp.screening.checks.find((c) => c.rule === "data_complete"), { rule: "data_complete", pass: false, actual: "funding:missing", threshold: "no gaps" });
  assert.deepEqual(result.sourceErrors.map((e) => e.endpoint), ["/api/v5/public/funding-rate?instId=ANY"]);
});

test("shortlistPerProduct limits book requests to the highest-turnover instruments", async () => {
  const db = openDb(":memory:");
  const { client, calls } = createFakeClient(marketRoutes());
  const result = await runScan(db, client, testStrategy({ shortlistPerProduct: 1, products: ["spot"] }), now);
  assert.deepEqual(result.candidates.map((c) => c.instId), ["GOOD-USDT"]);
  assert.ok(!calls.includes("/api/v5/market/books?instId=WIDE-USDT&sz=5"));
});

test("M0 scanning only calls read-only public and market endpoints", async () => {
  const db = openDb(":memory:");
  const { client, calls } = createFakeClient(marketRoutes());
  await runScan(db, client, testStrategy(), now);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((endpoint) => endpoint.startsWith("/api/v5/public/") || endpoint.startsWith("/api/v5/market/")));
});

const GOOD_SPOT: Instrument = {
  instId: "GOOD-USDT",
  product: "spot",
  baseCcy: "GOOD",
  quoteCcy: "USDT",
  state: "live",
  listTime: "2025-01-01T00:00:00.000Z",
  tickSz: "0.001",
  lotSz: "0.0001",
  minSz: "0.0001",
  ctVal: null,
};
const SCREENING = { minTurnover24hUsdt: "5000000", maxSpreadBps: "10", minDepthUsdtPerSide: "20000", minListingDays: 30, maxDataAgeMs: 120000 };

function snapshotWithTickerTs(ts: string, instrument: Instrument = GOOD_SPOT): MarketSnapshot {
  return buildSnapshot("global", instrument, {
    ticker: { row: { instId: "GOOD-USDT", last: "10", bidPx: "9.999", askPx: "10.001", open24h: "9", high24h: "10.5", low24h: "8.9", vol24h: "0", volCcy24h: "10000000", ts }, receivedAt: NOW.toISOString(), rawRef: "raw_t" },
    book: { row: { asks: [["10", "5000", "0", "1"]], bids: [["10", "5000", "0", "1"]], ts: FRESH_TS }, receivedAt: NOW.toISOString(), rawRef: "raw_b" },
  }, 5);
}

test("data freshness passes at exactly maxDataAgeMs and fails one millisecond later", () => {
  const atLimit = screenSnapshot(snapshotWithTickerTs("1793188680000"), SCREENING, NOW).find((c) => c.rule === "data_fresh");
  const overLimit = screenSnapshot(snapshotWithTickerTs("1793188679999"), SCREENING, NOW).find((c) => c.rule === "data_fresh");
  assert.deepEqual(atLimit, { rule: "data_fresh", pass: true, actual: "120000", threshold: "<= 120000 ms" });
  assert.deepEqual(overLimit, { rule: "data_fresh", pass: false, actual: "120001", threshold: "<= 120000 ms" });
});

test("listing age below the minimum fails, and an unknown listing time fails", () => {
  const recent = { ...GOOD_SPOT, listTime: "2026-09-29T12:00:00.000Z" }; // 29 days before NOW
  const unknown = { ...GOOD_SPOT, listTime: null };
  assert.deepEqual(screenSnapshot(snapshotWithTickerTs(FRESH_TS, recent), SCREENING, NOW).find((c) => c.rule === "listing_age"), { rule: "listing_age", pass: false, actual: "29", threshold: ">= 30 days" });
  assert.deepEqual(screenSnapshot(snapshotWithTickerTs(FRESH_TS, unknown), SCREENING, NOW).find((c) => c.rule === "listing_age"), { rule: "listing_age", pass: false, actual: null, threshold: ">= 30 days" });
});
