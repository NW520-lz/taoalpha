import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoReadSession, TRADE_KIT_VERSION, type TradeKitPeer } from "../../src/okx/trade-kit-demo-reader.ts";

const scope = { scopeId: "synthetic-demo-scope", site: "global" as const, environment: "demo" as const };
const endpoints: Record<string, string> = {
  account_get_config: "GET /api/v5/account/config", account_get_balance: "GET /api/v5/account/balance", account_get_positions: "GET /api/v5/account/positions",
  spot_get_orders: "GET /api/v5/trade/orders-pending", swap_get_orders: "GET /api/v5/trade/orders-pending",
  spot_get_algo_orders: "GET /api/v5/trade/orders-algo-pending", swap_get_algo_orders: "GET /api/v5/trade/orders-algo-pending",
  account_get_bills: "GET /api/v5/account/bills", spot_get_fills: "GET /api/v5/trade/fills", spot_get_order: "GET /api/v5/trade/order",
};

function fakePeer(options: {
  version?: string; demo?: boolean; readOnly?: boolean; hasAuth?: boolean; exposeWrite?: boolean;
  rows?: (name: string, args: Record<string, unknown>) => Record<string, unknown>[];
  error?: (name: string, args: Record<string, unknown>) => { code: string } | undefined;
} = {}) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const caps = { demo: options.demo ?? true, readOnly: options.readOnly ?? true, hasAuth: options.hasAuth ?? true };
  const peer: TradeKitPeer = {
    getServerVersion: () => ({ name: "okx-trade-mcp", version: options.version ?? TRADE_KIT_VERSION }),
    listTools: async () => ({ tools: ["system_get_capabilities", ...Object.keys(endpoints)].map((name) => ({ name, annotations: { readOnlyHint: true } })).concat(options.exposeWrite ? [{ name: "spot_place_order", annotations: { readOnlyHint: false } }] : []) }),
    callTool: async (input) => {
      calls.push(input);
      const failure = options.error?.(input.name, input.arguments);
      if (failure) return { isError: true, structuredContent: { tool: input.name, error: true, type: "OkxApiError", code: failure.code, capabilities: caps } };
      const data = input.name === "system_get_capabilities"
        ? { server: { name: "okx-trade-mcp", version: options.version ?? TRADE_KIT_VERSION }, capabilities: caps }
        : { endpoint: endpoints[input.name], requestTime: "2026-10-28T12:00:00Z", data: options.rows?.(input.name, input.arguments) ?? (["account_get_config", "account_get_balance"].includes(input.name) ? [{ synthetic: true }] : []) };
      return { structuredContent: { tool: input.name, ok: true, data, capabilities: caps } };
    },
  };
  return { peer, calls };
}

test("demo account reads use only fixed read tools and remain unreconciled even when every read succeeds", async () => {
  const { peer, calls } = fakePeer();
  const session = await createDemoReadSession(peer, scope);
  const snapshot = await session.refresh();
  assert.equal(snapshot.accountReadComplete, true);
  assert.equal(snapshot.reconciled, false);
  assert.equal(snapshot.executionAuthorized, false);
  assert.deepEqual(snapshot.missing, ["capital_history", "managed_ownership", "auto_add_margin_verification"]);
  assert.ok(calls.every((c) => c.name === "system_get_capabilities" || Object.hasOwn(endpoints, c.name)));
  assert.ok(calls.filter((c) => c.name.includes("algo_orders")).every((c) => c.arguments.status === "pending" && c.arguments.ordType));
});

test("live, unauthenticated, writable or unpinned servers fail before any account read", async () => {
  for (const options of [{ demo: false }, { readOnly: false }, { hasAuth: false }, { version: "0.0.0" }, { exposeWrite: true }]) {
    const { peer, calls } = fakePeer(options);
    await assert.rejects(createDemoReadSession(peer, scope));
    assert.ok(calls.every((c) => c.name === "system_get_capabilities"));
  }
});

test("open orders page through stable IDs instead of treating a full page as the complete account", async () => {
  const { peer, calls } = fakePeer({ rows: (name, args) => {
    if (name === "spot_get_orders") return args.after ? [{ ordId: "older-101" }] : Array.from({ length: 100 }, (_, i) => ({ ordId: `order-${i + 1}` }));
    return ["account_get_config", "account_get_balance"].includes(name) ? [{}] : [];
  } });
  const snapshot = await (await createDemoReadSession(peer, scope)).refresh();
  const part = snapshot.parts.spotOrders;
  assert.equal(part.status, "ok");
  if (part.status !== "ok") throw new Error("fixture");
  assert.deepEqual(part.pages.map((p) => p.rows.length), [100, 1]);
  assert.equal(calls.find((c) => c.name === "spot_get_orders" && c.arguments.after)?.arguments.after, "order-100");
});

test("a repeating pagination page or a read failure is unavailable, never an empty position/order list", async () => {
  const { peer } = fakePeer({ rows: (name) => {
    if (name === "spot_get_orders") return Array.from({ length: 100 }, (_, i) => ({ ordId: `repeat-${i}` }));
    if (name === "account_get_positions") throw new Error("synthetic-sensitive-error-sentinel");
    return ["account_get_config", "account_get_balance"].includes(name) ? [{}] : [];
  } });
  const snapshot = await (await createDemoReadSession(peer, scope)).refresh();
  assert.equal(snapshot.accountReadComplete, false);
  assert.deepEqual(snapshot.parts.spotOrders, { status: "unavailable", reason: "read_failed_or_incomplete" });
  assert.deepEqual(snapshot.parts.positions, { status: "unavailable", reason: "read_failed_or_incomplete" });
  assert.doesNotMatch(JSON.stringify(snapshot), /sensitive-error-sentinel/);
});

test("a response claiming a different endpoint or environment cannot be accepted as account data", async () => {
  const { peer } = fakePeer();
  const call = peer.callTool;
  peer.callTool = async (input) => {
    const value = await call(input);
    if (input.name === "account_get_balance") return { structuredContent: { tool: input.name, ok: true, capabilities: { readOnly: true, demo: false, hasAuth: true }, data: [] } };
    if (input.name === "account_get_positions") return { structuredContent: { tool: input.name, ok: true, capabilities: { readOnly: true, demo: true, hasAuth: true }, data: { endpoint: "POST /api/v5/trade/order", requestTime: "2026-10-28T12:00:00Z", data: [] } } };
    return value;
  };
  const snapshot = await (await createDemoReadSession(peer, scope)).refresh();
  assert.equal(snapshot.parts.balance.status, "unavailable");
  assert.equal(snapshot.parts.positions.status, "unavailable");
});

test("capital bills and spot fills are read as their own parts, paged by bill id", async () => {
  const { peer, calls } = fakePeer({ rows: (name) => name === "account_get_bills" ? [{ billId: "b1", type: "1" }] : name === "spot_get_fills" ? [{ billId: "f1", clOrdId: "taeA" }] : (["account_get_config", "account_get_balance"].includes(name) ? [{ synthetic: true }] : []) });
  const snapshot = await (await createDemoReadSession(peer, scope)).refresh();
  assert.equal(snapshot.accountReadComplete, true);
  assert.deepEqual([snapshot.parts.bills.status === "ok" && snapshot.parts.bills.pages[0]!.rows, snapshot.parts.fills.status === "ok" && snapshot.parts.fills.pages[0]!.rows], [[{ billId: "b1", type: "1" }], [{ billId: "f1", clOrdId: "taeA" }]]);
  assert.deepEqual(calls.filter((c) => c.name === "account_get_bills" || c.name === "spot_get_fills").map((c) => [c.name, c.arguments.limit]), [["account_get_bills", 100], ["spot_get_fills", 100]]);
});

test("a single order is looked up by client order id; only the exchange's not-found code means absent", async () => {
  const { peer } = fakePeer({ rows: (name, args) => name === "spot_get_order" && args.clOrdId === "taeA" ? [{ clOrdId: "taeA", state: "filled" }] : [{ synthetic: true }],
    error: (name, args) => name === "spot_get_order" ? (args.clOrdId === "taeMissing" ? { code: "51603" } : args.clOrdId === "taeBroken" ? { code: "50001" } : undefined) : undefined });
  const session = await createDemoReadSession(peer, scope);
  assert.deepEqual(await session.orderByClientId("BTC-USDT", "taeA"), { status: "found", row: { clOrdId: "taeA", state: "filled" } });
  assert.deepEqual(await session.orderByClientId("BTC-USDT", "taeMissing"), { status: "not_found" });
  await assert.rejects(session.orderByClientId("BTC-USDT", "taeBroken"));
});
