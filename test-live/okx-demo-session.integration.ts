import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/db.ts";
import { createDemoAccountSession } from "../src/account/demo-session.ts";
import type { DemoSite } from "../src/okx/trade-kit-demo-reader.ts";

/** Explicit opt-in only. Uses an ephemeral database and never prints account data. */
test("demo account scope remains bound through three fresh read-only refreshes", { timeout: 90_000 }, async () => {
  const db = openDb(":memory:");
  try {
    const session = createDemoAccountSession(db, {
      scopeId: "scope:local-demo-check",
      profile: process.env.TAOALPHA_DEMO_PROFILE ?? "taoalpha_demo",
      site: (process.env.TAOALPHA_DEMO_SITE ?? "global") as DemoSite,
    });
    let previousRef: string | null = null;
    for (let round = 0; round < 3; round += 1) {
      const result = await session.refresh();
      assert.equal(result.status, "bound");
      assert.equal(result.accountRef !== null, true);
      assert.equal(previousRef === null || previousRef === result.accountRef, true, "account scope changed");
      previousRef = result.accountRef;
      assert.equal(result.reconciled, false);
      assert.equal(result.executionAuthorized, false);
      assert.equal(result.blockNewRisk, true);
      assert.equal(session.getInternalSnapshot() !== null, true, "fresh private state unavailable");
    }
  } finally {
    db.close();
  }
});
