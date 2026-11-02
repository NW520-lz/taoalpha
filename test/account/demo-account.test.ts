import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDemoAccount } from "../../src/account/demo-account.ts";
import type { DemoReadSnapshot } from "../../src/okx/trade-kit-demo-reader.ts";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const OLD_UPDATE = "1700000000000";
const PRECISE = "123456789012345678901234567890.00000000000000000001";
const ENDPOINTS = {
  config: "GET /api/v5/account/config", balance: "GET /api/v5/account/balance", positions: "GET /api/v5/account/positions",
  spotOrders: "GET /api/v5/trade/orders-pending", perpetualOrders: "GET /api/v5/trade/orders-pending",
  spotProtection: "GET /api/v5/trade/orders-algo-pending", perpetualProtection: "GET /api/v5/trade/orders-algo-pending",
  bills: "GET /api/v5/account/bills", fills: "GET /api/v5/trade/fills",
} as const;
function position(overrides: Record<string, unknown> = {}) {
  return { posId: "synthetic-position-sentinel", instId: "BTC-USDT-SWAP", instType: "SWAP", mgnMode: "isolated", posSide: "net", pos: "-0.00000000000000000001", ccy: "USDT", uTime: OLD_UPDATE, ...overrides };
}
function fixture(): DemoReadSnapshot {
  const rows: Record<keyof typeof ENDPOINTS, Record<string, unknown>[]> = {
    config: [{ uid: "synthetic-identity-sentinel", acctLv: "4", posMode: "long_short_mode", arbitrarySecret: "do-not-copy-sentinel" }],
    balance: [{ totalEq: PRECISE, uTime: OLD_UPDATE, details: [{ ccy: "BTC", eq: "0.00000000000000000001", cashBal: "", availBal: "", frozenBal: "" }] }],
    positions: [position()], spotOrders: [], perpetualOrders: [], spotProtection: [], perpetualProtection: [], bills: [], fills: [],
  };
  return { scope: { scopeId: "synthetic", site: "global", environment: "demo" },
    parts: Object.fromEntries(Object.entries(ENDPOINTS).map(([part, endpoint]) => [part, { status: "ok", pages: [{ endpoint, requestTime: NOW.toISOString(), rows: rows[part as keyof typeof rows] }] }])) as DemoReadSnapshot["parts"],
    accountReadComplete: true, reconciled: false, executionAuthorized: false, missing: ["capital_history", "managed_ownership", "auto_add_margin_verification"] };
}
function rows(input: DemoReadSnapshot, part: keyof typeof ENDPOINTS) {
  const value = input.parts[part];
  assert.equal(value.status, "ok");
  return value.pages[0]!.rows;
}

test("normalization preserves exact USD/coin/contract strings and explicit modes without authorizing risk", () => {
  const input = fixture();
  const result = normalizeDemoAccount(input, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.account.config, { uid: "synthetic-identity-sentinel", accountLevel: "4", positionMode: "long_short_mode" });
  assert.deepEqual(result.account.equity, { total: { amount: PRECISE, unit: "USD" }, updatedAtMs: OLD_UPDATE,
    assets: [{ currency: "BTC", equity: { amount: "0.00000000000000000001", unit: "coin" } }] });
  assert.deepEqual(result.account.positions, [{ positionId: "synthetic-position-sentinel", instrumentId: "BTC-USDT-SWAP", instrumentType: "SWAP", marginMode: "isolated", positionSide: "net", contracts: "-0.00000000000000000001", quantityUnit: "contracts", marginCurrency: "USDT", updatedAtMs: OLD_UPDATE }]);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.reconciled, false);
  assert.equal(result.blockNewRisk, true);
  assert.doesNotMatch(JSON.stringify(result), /do-not-copy-sentinel|cashBal|managedEquity/);
  rows(input, "config")[0]!.uid = "changed";
  assert.equal(result.account.config.uid, "synthetic-identity-sentinel");
});

test("unknown/missing account configuration fails with fixed checks and no private values", () => {
  for (const mutate of [
    (input: DemoReadSnapshot) => { rows(input, "config")[0]!.uid = ""; },
    (input: DemoReadSnapshot) => { rows(input, "config")[0]!.acctLv = "synthetic-unknown-mode-sentinel"; },
    (input: DemoReadSnapshot) => { rows(input, "config")[0]!.posMode = "synthetic-unknown-mode-sentinel"; },
    (input: DemoReadSnapshot) => { rows(input, "config").push({ ...rows(input, "config")[0] }); },
    (input: DemoReadSnapshot) => { rows(input, "config").length = 0; },
  ]) {
    const input = fixture(); mutate(input);
    const result = normalizeDemoAccount(input, NOW);
    assert.equal(result.ok, false);
    assert.equal("account" in result, false);
    assert.equal(result.validation.parts.find((part) => part.part === "config")!.status, "failed");
    assert.doesNotMatch(JSON.stringify(result), /sentinel|123456789|BTC/);
    assert.equal(result.blockNewRisk, true);
  }
});

test("malformed/duplicate balance rows and assets fail; genuinely empty asset details remain valid", () => {
  for (const mutate of [
    (b: Record<string, unknown>) => { b.totalEq = "1e9"; },
    (b: Record<string, unknown>) => { b.totalEq = Infinity; },
    (b: Record<string, unknown>) => { b.totalEq = ""; },
    (b: Record<string, unknown>) => { b.details = null; },
    (b: Record<string, unknown>) => { b.details = [{ ccy: "", eq: "1" }]; },
    (b: Record<string, unknown>) => { b.details = [{ ccy: "BTC", eq: ".5" }]; },
    (b: Record<string, unknown>) => { b.details = [{ ccy: "BTC", eq: "1" }, { ccy: "BTC", eq: "2" }]; },
    (b: Record<string, unknown>) => { b.uTime = "0"; },
    (b: Record<string, unknown>) => { b.uTime = "invalid-private-time-sentinel"; },
    (b: Record<string, unknown>) => { b.uTime = String(NOW.getTime() + 5001); },
  ]) {
    const input = fixture(); mutate(rows(input, "balance")[0]!);
    const result = normalizeDemoAccount(input, NOW);
    assert.equal(result.ok, false);
    assert.equal("account" in result, false);
    assert.equal(result.validation.parts.find((part) => part.part === "balance")!.status, "failed");
    assert.doesNotMatch(JSON.stringify(result), /sentinel|BTC|123456789/);
  }
  for (const count of [0, 2]) {
    const input = fixture(); const balance = rows(input, "balance");
    if (count === 0) balance.length = 0; else balance.push({ ...balance[0] });
    assert.equal(normalizeDemoAccount(input, NOW).ok, false);
  }
  const input = fixture(); rows(input, "balance")[0]!.details = [];
  rows(input, "balance")[0]!.totalEq = "0";
  rows(input, "balance")[0]!.uTime = String(NOW.getTime() + 5000);
  const result = normalizeDemoAccount(input, NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.account.equity.assets, []);
});

test("positions validate contract direction, identity, product and timestamps without hiding rejected exposure", () => {
  for (const overrides of [
    { posId: "" }, { instId: "" }, { instType: "FUTURES" }, { mgnMode: "unknown" }, { posSide: "unknown" },
    { pos: "1e2" }, { pos: NaN }, { pos: "" }, { pos: "-1", posSide: "long" }, { pos: "-0.1", posSide: "short" },
    { uTime: "" }, { uTime: "0" }, { uTime: String(NOW.getTime() + 5001) },
  ]) {
    const input = fixture(); rows(input, "positions").push(position({ ...overrides, posId: overrides.posId ?? "synthetic-rejected-position" }));
    const result = normalizeDemoAccount(input, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.observedRows.positions, 2);
    assert.equal("account" in result, false);
    assert.doesNotMatch(JSON.stringify(result), /sentinel|BTC|USDT|123456789/);
  }
  for (const overrides of [{ instId: "BTC-USD-SWAP", ccy: "BTC" }, { ccy: "" }, { ccy: "BTC" }, { settleCcy: "USD" }, { ctType: "inverse" }]) {
    const input = fixture(); rows(input, "positions")[0] = position(overrides);
    const result = normalizeDemoAccount(input, NOW);
    assert.equal(result.ok, false);
    assert.ok(result.validation.parts.find((part) => part.part === "positions")!.gaps.includes("unsupported_product"));
    assert.equal(result.observedRows.positions, 1);
  }
  const duplicate = fixture(); rows(duplicate, "positions").push(position());
  assert.equal(normalizeDemoAccount(duplicate, NOW).ok, false);
  for (const overrides of [{ pos: "0", posSide: "long" }, { pos: "0.00000000000000000001", posSide: "short", mgnMode: "cross" }, { pos: "-0", posSide: "long" }]) {
    const input = fixture(); rows(input, "positions")[0] = position(overrides);
    assert.equal(normalizeDemoAccount(input, NOW).ok, true);
  }
  const empty = fixture(); rows(empty, "positions").length = 0;
  const result = normalizeDemoAccount(empty, NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.account.positions, []);
});

test("every required read checks exact provenance and inclusive local observation time boundaries", () => {
  for (const part of Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[]) {
    for (const mutate of [
      (input: DemoReadSnapshot) => { input.parts[part] = { status: "unavailable", reason: "read_failed_or_incomplete" }; },
      (input: DemoReadSnapshot) => { delete (input.parts as Partial<DemoReadSnapshot["parts"]>)[part]; },
      (input: DemoReadSnapshot) => { const source = input.parts[part]; if (source.status === "ok") source.pages = []; },
      (input: DemoReadSnapshot) => { const source = input.parts[part]; if (source.status === "ok") source.pages[0]!.endpoint += "/unexpected-private-sentinel"; },
      ...["", "2026-10-28", "Infinity", "not-private-time-sentinel", new Date(NOW.getTime() - 30001).toISOString(), new Date(NOW.getTime() + 5001).toISOString()].map((requestTime) =>
        (input: DemoReadSnapshot) => { const source = input.parts[part]; if (source.status === "ok") source.pages[0]!.requestTime = requestTime; }),
    ]) {
      const input = fixture(); mutate(input);
      const result = normalizeDemoAccount(input, NOW);
      assert.equal(result.ok, false, part);
      assert.equal("account" in result, false);
      assert.notEqual(result.validation.parts.find((value) => value.part === part)!.status, "ok");
      assert.doesNotMatch(JSON.stringify(result), /sentinel|BTC|123456789/);
    }
    for (const offset of [-30000, 5000]) {
      const input = fixture(); const source = input.parts[part];
      if (source.status === "ok") source.pages[0]!.requestTime = new Date(NOW.getTime() + offset).toISOString();
      assert.equal(normalizeDemoAccount(input, NOW).ok, true, `${part}:${offset}`);
    }
  }
  const incomplete = fixture(); incomplete.accountReadComplete = false;
  assert.equal(normalizeDemoAccount(incomplete, NOW).ok, false);
  for (const now of [new Date(NaN), new Date(0), undefined, "", Infinity]) {
    assert.equal(normalizeDemoAccount(fixture(), now as Date).ok, false);
  }
});
