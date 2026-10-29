import { test } from "node:test";
import assert from "node:assert/strict";
import { runDemoCheck } from "../src/demo-check.ts";
import type { DemoReadSnapshot } from "../src/okx/trade-kit-demo-reader.ts";

function snapshot(): DemoReadSnapshot {
  const page = { status: "ok" as const, pages: [{ endpoint: "GET /synthetic", requestTime: "2026-10-28T12:00:00Z", rows: [{ uid: "synthetic-private-account-sentinel", equity: "synthetic-private-balance-sentinel" }] }] };
  return { scope: { scopeId: "synthetic", site: "global", environment: "demo" },
    parts: { config: page, balance: page, positions: page, spotOrders: page, perpetualOrders: page, spotProtection: page, perpetualProtection: page },
    accountReadComplete: true, reconciled: false, executionAuthorized: false, missing: ["capital_history", "managed_ownership", "auto_add_margin_verification"] };
}

test("demo check reports statuses/counts, always closes the reader and cannot print private account rows", async () => {
  let closed = false;
  const result = await runDemoCheck(["--profile", "synthetic_demo", "--site", "global"], async () => ({ refresh: async () => snapshot(), close: async () => { closed = true; } }));
  assert.equal(result.ok, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.reconciled, false);
  assert.equal(closed, true);
  assert.doesNotMatch(JSON.stringify(result), /private-account-sentinel|private-balance-sentinel/);
});

test("demo check rejects ambiguous input and hides unexpected upstream diagnostics", async () => {
  let connected = false;
  const invalid = await runDemoCheck(["--profile", "x", "--site", "invalid"], async () => { connected = true; throw new Error("fixture"); });
  assert.equal(invalid.ok, false);
  assert.equal(connected, false);
  const failed = await runDemoCheck(["--profile", "x", "--site", "global"], async () => { throw new Error("synthetic-secret-sentinel"); });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /secret-sentinel/);
});
