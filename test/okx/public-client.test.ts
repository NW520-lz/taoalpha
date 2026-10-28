import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, type FetchLike } from "../../src/okx/public-client.ts";

const FIXED_NOW = new Date("2026-10-28T12:00:00.000Z");

function fakeFetch(status: number, body: string, calls: string[] = []): FetchLike {
  return async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return { status, text: async () => body };
  };
}

test("GETs the global site and returns rows with the raw response", async () => {
  const calls: string[] = [];
  const client = createPublicClient({
    fetch: fakeFetch(200, '{"code":"0","msg":"","data":[{"instId":"BTC-USDT"}]}', calls),
    now: () => FIXED_NOW,
  });
  const result = await client.get<{ instId: string }>("/api/v5/market/ticker", { instId: "BTC-USDT" });
  assert.deepEqual(calls, ["GET https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"]);
  assert.ok(result.ok);
  assert.deepEqual(result.rows, [{ instId: "BTC-USDT" }]);
  assert.equal(result.endpoint, "/api/v5/market/ticker?instId=BTC-USDT");
  assert.deepEqual(result.raw, {
    endpoint: "/api/v5/market/ticker?instId=BTC-USDT",
    receivedAt: "2026-10-28T12:00:00.000Z",
    status: 200,
    body: '{"code":"0","msg":"","data":[{"instId":"BTC-USDT"}]}',
  });
  assert.equal(client.site, "global");
});

test("an OKX error code is reported as an okx error, not as empty data", async () => {
  const body = '{"code":"51001","data":[],"msg":"Instrument ID doesn\'t exist."}';
  const client = createPublicClient({ fetch: fakeFetch(200, body), now: () => FIXED_NOW });
  const result = await client.get("/api/v5/market/ticker", { instId: "NOPE-USDT" });
  assert.ok(!result.ok);
  assert.deepEqual(result.error, { kind: "okx", code: "51001", msg: "Instrument ID doesn't exist." });
  assert.equal(result.raw?.body, body);
});

test("a non-200 status is an http error", async () => {
  const client = createPublicClient({ fetch: fakeFetch(429, "Too Many Requests"), now: () => FIXED_NOW });
  const result = await client.get("/api/v5/market/tickers", { instType: "SPOT" });
  assert.ok(!result.ok);
  assert.deepEqual(result.error, { kind: "http", status: 429 });
});

test("a thrown fetch is a network error without a raw response", async () => {
  const client = createPublicClient({
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND www.okx.com");
    },
  });
  const result = await client.get("/api/v5/market/tickers", { instType: "SPOT" });
  assert.ok(!result.ok);
  assert.deepEqual(result.error, { kind: "network", message: "getaddrinfo ENOTFOUND www.okx.com" });
  assert.equal(result.raw, null);
});

test("an unparseable body is a parse error", async () => {
  const client = createPublicClient({ fetch: fakeFetch(200, "<html>blocked</html>"), now: () => FIXED_NOW });
  const result = await client.get("/api/v5/market/tickers", { instType: "SPOT" });
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "parse");
});

test("refuses any path outside the read-only public and market APIs", async () => {
  const calls: string[] = [];
  const client = createPublicClient({ fetch: fakeFetch(200, '{"code":"0","data":[]}', calls) });
  await assert.rejects(client.get("/api/v5/trade/order", {}), /only reads \/api\/v5\/public and \/api\/v5\/market/);
  await assert.rejects(client.get("/api/v5/account/balance", {}), /only reads/);
  assert.deepEqual(calls, []);
});
