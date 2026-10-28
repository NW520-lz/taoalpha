// Smoke test of the real scan query forms (bulk funding / open-interest / mark-price / index-tickers) against OKX.
// Requires network; run with `npm run test:live`. No credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient } from "../src/okx/public-client.ts";
import { runScan } from "../src/scan/scan.ts";
import { openDb } from "../src/store/db.ts";
import { getEvidence } from "../src/store/evidence-store.ts";
import type { MarketSnapshot } from "../src/market/snapshot.ts";
import { testStrategy } from "../test/helpers/market-fixtures.ts";

test("runScan against real OKX: no source errors, both products ok, perpetual snapshots have no gaps", async () => {
  const db = openDb(":memory:");
  const client = createPublicClient();
  const strategy = testStrategy({ shortlistPerProduct: 2, screening: null });
  const result = await runScan(db, client, strategy, () => new Date());

  console.log(
    JSON.stringify({
      sourceErrors: result.sourceErrors,
      products: result.products,
      candidates: result.candidates.map((c) => ({ instId: c.instId, product: c.product, turnover24hUsdt: c.turnover24hUsdt })),
    }, null, 2),
  );
  assert.deepEqual(result.sourceErrors, []);
  assert.equal(result.products.length, 2);
  for (const status of result.products) assert.equal(status.status, "ok", `${status.product} scan status`);
  assert.equal(result.candidates.length, 4);

  for (const candidate of result.candidates.filter((c) => c.product === "usdt_perpetual")) {
    const snapshot = getEvidence(db, candidate.snapshotEvidenceId)?.content as MarketSnapshot;
    console.log(`${candidate.instId} snapshot gaps: ${JSON.stringify(snapshot.gaps)}`);
    assert.deepEqual(snapshot.gaps, [], `${candidate.instId} has gaps`);
  }
});
