// Public-only historical endpoint checks; these do not validate a strategy or any account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient } from "../src/okx/public-client.ts";
import { collectHistory } from "../src/market/history.ts";

const hour = 60 * 60 * 1000;

for (const [instId, product] of [["BTC-USDT", "spot"], ["BTC-USDT-SWAP", "usdt_perpetual"]] as const) {
  test(`public history ${product} keeps closed candles and explicit provenance gaps`, async () => {
    const asOf = Date.now();
    const end = Math.floor(asOf / hour) * hour;
    const manifest = await collectHistory(createPublicClient(), {
      instId, product, resolution: "1H", start: end - 24 * hour, end, asOf,
      capturedAt: new Date(asOf).toISOString(), limit: 100, maxPages: 3,
    });
    assert.ok(manifest.sources.length >= 1);
    assert.ok(manifest.sources.every(source => source.status === 200 && source.sha256 && source.error === null), "public history source unavailable or rejected");
    assert.equal(manifest.candleCoverage, "complete");
    assert.equal(manifest.candles.length, 24);
    assert.ok(manifest.candles.every(candle => candle.closeTime <= asOf));
    assert.equal(manifest.availability, "historical_publication_unverified");
    assert.equal(manifest.historicalUniverse, "unknown_survivorship_gap");
    assert.equal(manifest.funding.status, product === "spot" ? "not_applicable" : "unknown");
    assert.equal(manifest.strategyValid, false);
    assert.equal(manifest.executionAuthorized, false);
  });
}
