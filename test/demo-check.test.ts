import { test } from "node:test";
import assert from "node:assert/strict";
import { runDemoCheck } from "../src/demo-check.ts";
import { DomainError } from "../src/lib/errors.ts";
import type { DemoReadSnapshot } from "../src/okx/trade-kit-demo-reader.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
function snapshot(): DemoReadSnapshot {
  function page(endpoint: string, rows: Record<string, unknown>[] = []) { return { status: "ok" as const, pages: [{ endpoint: `GET /api/v5/${endpoint}`, requestTime: NOW.toISOString(), rows }] }; }
  return { scope: { scopeId: "synthetic", site: "global", environment: "demo" },
    parts: {
      config: page("account/config", [{ uid: "synthetic-private-account-sentinel", acctLv: "2", posMode: "net_mode" }]),
      balance: page("account/balance", [{ totalEq: "100.000000000000001", uTime: "1700000000000", privateExtra: "synthetic-private-balance-sentinel", details: [{ ccy: "SYNTHETIC_PRIVATE_ASSET", eq: "1" }] }]),
      positions: page("account/positions", [{ posId: "synthetic-private-position-sentinel", instId: "BTC-USDT-SWAP", instType: "SWAP", mgnMode: "isolated", posSide: "net", pos: "-1.000000000000001", ccy: "USDT", uTime: "1700000000000" }]),
      spotOrders: page("trade/orders-pending", [{ ordId: "synthetic-private-order-sentinel" }]), perpetualOrders: page("trade/orders-pending"),
      spotProtection: page("trade/orders-algo-pending"), perpetualProtection: page("trade/orders-algo-pending"), bills: page("account/bills"), fills: page("trade/fills"),
    },
    accountReadComplete: true, reconciled: false, executionAuthorized: false, missing: ["capital_history", "managed_ownership", "auto_add_margin_verification"] };
}

test("demo check reports statuses/counts, always closes the reader and cannot print private account rows", async () => {
  let closed = false;
  const result = await runDemoCheck(["--profile", "synthetic_demo", "--site", "global"], async () => ({ refresh: async () => snapshot(), close: async () => { closed = true; } }), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.reconciled, false);
  assert.equal(result.blockNewRisk, true);
  assert.equal(result.connectivityOk, true);
  assert.equal(result.accountValidation.status, "ok");
  assert.equal(closed, true);
  assert.doesNotMatch(JSON.stringify(result), /private-account-sentinel|private-balance-sentinel|private-position-sentinel|private-order-sentinel|SYNTHETIC_PRIVATE_ASSET|100\.000000000000001|net_mode|isolated|BTC-USDT-SWAP|1700000000000/);
});

test("successful connectivity with invalid private semantics fails safely and keeps all risk gaps", async () => {
  const input = snapshot();
  if (input.parts.config.status === "ok") input.parts.config.pages[0]!.rows[0]!.posMode = "synthetic-private-mode-sentinel";
  let closed = 0;
  const result = await runDemoCheck(["--profile", "synthetic_demo", "--site", "global"], async () => ({ refresh: async () => input, close: async () => { closed++; } }), NOW);
  assert.equal(result.ok, false);
  assert.equal(result.connectivityOk, true);
  assert.equal(result.accountValidation.status, "failed");
  assert.equal(result.blockNewRisk, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(closed, 1);
  assert.deepEqual(result.missing, ["capital_history", "managed_ownership", "auto_add_margin_verification", "contract_metadata_valuation", "protected_coverage", "approved_risk_config"]);
  assert.doesNotMatch(JSON.stringify(result), /sentinel|SYNTHETIC_PRIVATE_ASSET|net_mode|BTC-USDT-SWAP/);
});

test("demo check rejects ambiguous input and hides unexpected upstream diagnostics", async () => {
  let connected = false;
  const invalid = await runDemoCheck(["--profile", "x", "--site", "invalid"], async () => { connected = true; throw new Error("fixture"); });
  assert.equal(invalid.ok, false);
  assert.equal(connected, false);
  const failed = await runDemoCheck(["--profile", "x", "--site", "global"], async () => { throw new Error("synthetic-secret-sentinel"); });
  assert.equal(failed.ok, false);
  assert.equal(failed.blockNewRisk, true);
  assert.doesNotMatch(JSON.stringify(failed), /secret-sentinel/);
});

test("configuration failures keep only recognized fixed rule IDs, never upstream diagnostic content", async () => {
  const result = await runDemoCheck(["--profile", "x", "--site", "global"], async () => { throw new DomainError("DEPENDENCY_UNAVAILABLE", "synthetic-secret-sentinel", [
    { ruleId: "tradekit.profile_present", field: "synthetic-field-sentinel" }, { ruleId: "synthetic-rule-sentinel" },
  ]); }, NOW);
  assert.equal(result.ok, false);
  assert.deepEqual(result.error?.rules, ["tradekit.profile_present"]);
  assert.doesNotMatch(JSON.stringify(result), /sentinel/);
});

test("missing reads, stale secondary pages and refresh failures stay blocked and close the reader", async () => {
  for (const scenario of ["missing", "stale-page", "throw"]) {
    const input = snapshot();
    if (scenario === "missing") delete (input.parts as Partial<DemoReadSnapshot["parts"]>).spotOrders;
    if (scenario === "stale-page" && input.parts.spotOrders.status === "ok") input.parts.spotOrders.pages.push({ endpoint: "GET /api/v5/trade/orders-pending", requestTime: "2026-10-28T11:59:29.999Z", rows: [{ ordId: "synthetic-secondary-page-sentinel" }] });
    (input.parts as unknown as Record<string, unknown>)["synthetic-part-sentinel"] = { status: "ok", pages: [] };
    (input as unknown as Record<string, unknown>).missing = ["synthetic-gap-sentinel"];
    let closed = false;
    const result = await runDemoCheck(["--profile", "x", "--site", "global"], async () => ({
      refresh: async () => { if (scenario === "throw") throw new Error("synthetic-refresh-sentinel"); return input; },
      close: async () => { closed = true; throw new Error("synthetic-close-sentinel"); },
    }), NOW);
    assert.equal(result.ok, false);
    assert.equal(result.blockNewRisk, true);
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.reconciled, false);
    assert.equal(closed, true);
    assert.equal(result.connectivityOk, scenario === "stale-page");
    assert.doesNotMatch(JSON.stringify(result), /sentinel/);
    if (scenario === "stale-page" && "reads" in result) assert.equal(result.reads!.find((part) => part.part === "spotOrders")!.rows, 2);
  }
});
