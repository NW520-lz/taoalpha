import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { createDemoAccountSession } from "../../src/account/demo-session.ts";
import type { DemoReadSnapshot, DemoScope } from "../../src/okx/trade-kit-demo-reader.ts";

const AT = new Date("2026-10-29T12:00:00.000Z");
const endpoints = {
  config: "GET /api/v5/account/config", balance: "GET /api/v5/account/balance", positions: "GET /api/v5/account/positions",
  spotOrders: "GET /api/v5/trade/orders-pending", perpetualOrders: "GET /api/v5/trade/orders-pending",
  spotProtection: "GET /api/v5/trade/orders-algo-pending", perpetualProtection: "GET /api/v5/trade/orders-algo-pending",
  bills: "GET /api/v5/account/bills", fills: "GET /api/v5/trade/fills",
} as const;

function snapshot(scope: DemoScope, uid = "synthetic-uid-sentinel"): DemoReadSnapshot {
  const data: Record<keyof typeof endpoints, Record<string, unknown>[]> = {
    config: [{ uid, acctLv: "2", posMode: "net_mode" }],
    balance: [{ totalEq: "12345.67890123456789", uTime: "1700000000000", details: [{ ccy: "USDT", eq: "12345.67890123456789" }] }],
    positions: [], spotOrders: [], perpetualOrders: [], spotProtection: [], perpetualProtection: [], bills: [], fills: [],
  };
  return { scope, parts: Object.fromEntries(Object.entries(endpoints).map(([part, endpoint]) =>
    [part, { status: "ok", pages: [{ endpoint, requestTime: AT.toISOString(), rows: data[part as keyof typeof endpoints] }] }])) as DemoReadSnapshot["parts"],
    accountReadComplete: true, reconciled: false, executionAuthorized: false,
    missing: ["capital_history", "managed_ownership", "auto_add_margin_verification"] };
}

test("binds a demo scope to an opaque account reference without exposing account values or authorizing risk", async () => {
  const db = openDb(":memory:");
  let closed = 0;
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({ refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }), close: async () => { closed += 1; } });
  const session = createDemoAccountSession(db, { scopeId: "scope:synthetic", profile: "synthetic", site: "global" }, { now: () => AT, connect });
  const first = await session.refresh();
  assert.equal(first.status, "bound");
  assert.match(first.accountRef!, /^account:[0-9a-f-]{36}$/);
  assert.equal(first.blockNewRisk, true);
  assert.equal(first.executionAuthorized, false);
  assert.equal(first.reconciled, false);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-uid-sentinel|12345\.6789/);
  assert.equal((await session.refresh()).accountRef, first.accountRef);
  assert.equal(closed, 2);
  db.close();
});

test("an identity change stays locked across a fresh session even if the original identity returns", async () => {
  const db = openDb(":memory:");
  let uid = "synthetic-original";
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }, uid), close: async () => {},
  });
  const config = { scopeId: "scope:one", profile: "synthetic", site: "global" as const };
  const firstSession = createDemoAccountSession(db, config, { now: () => AT, connect });
  assert.equal((await firstSession.refresh()).status, "bound");
  uid = "synthetic-unexpected";
  assert.equal((await firstSession.refresh()).status, "identity_mismatch");
  uid = "synthetic-original";
  const restarted = createDemoAccountSession(db, config, { now: () => AT, connect });
  const locked = await restarted.refresh();
  assert.equal(locked.status, "identity_mismatch");
  assert.equal(locked.blockNewRisk, true);
  assert.doesNotMatch(JSON.stringify(locked), /synthetic-original|synthetic-unexpected/);
  db.close();
});

test("one exchange identity cannot be silently registered under two scope budgets", async () => {
  const db = openDb(":memory:");
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }), close: async () => {},
  });
  const first = createDemoAccountSession(db, { scopeId: "scope:first", profile: "a", site: "global" }, { now: () => AT, connect });
  const second = createDemoAccountSession(db, { scopeId: "scope:second", profile: "b", site: "global" }, { now: () => AT, connect });
  assert.equal((await first.refresh()).status, "bound");
  assert.equal((await second.refresh()).status, "identity_conflict");
  assert.throws(() => createDemoAccountSession(db, { scopeId: "scope:first", profile: "a", site: "us" }, { now: () => AT, connect }));
  db.close();
});

test("private snapshots expire and are cleared on read failure or process restart", async () => {
  const db = openDb(":memory:");
  let clock = AT;
  let fail = false;
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => { if (fail) throw new Error("synthetic-private-upstream-sentinel"); return snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }); },
    close: async () => {},
  });
  const config = { scopeId: "scope:fresh", profile: "synthetic", site: "global" as const };
  const session = createDemoAccountSession(db, config, { now: () => clock, connect });
  assert.equal((await session.refresh()).status, "bound");
  const privateSnapshot = session.getInternalSnapshot();
  assert.equal(privateSnapshot?.account.equity.total.unit, "USD");
  assert.doesNotMatch(JSON.stringify(privateSnapshot), /synthetic-uid-sentinel/);
  clock = new Date(AT.getTime() + 30_001);
  assert.equal(session.getInternalSnapshot(), null);
  clock = AT;
  assert.equal(session.getInternalSnapshot(), null, "a clock rollback cannot revive a stale snapshot");
  fail = true;
  const failed = await session.refresh();
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.blockNewRisk, true);
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-upstream-sentinel|12345\.6789/);
  assert.equal(session.getInternalSnapshot(), null);
  const restarted = createDemoAccountSession(db, config, { now: () => clock, connect });
  assert.equal(restarted.getInternalSnapshot(), null);
  db.close();
});

test("a conflict detected by another session invalidates an earlier in-memory snapshot", async () => {
  const db = openDb(":memory:");
  let uid = "synthetic-original";
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }, uid), close: async () => {},
  });
  const config = { scopeId: "scope:shared", profile: "synthetic", site: "global" as const };
  const first = createDemoAccountSession(db, config, { now: () => AT, connect });
  const second = createDemoAccountSession(db, config, { now: () => AT, connect });
  assert.equal((await first.refresh()).status, "bound");
  assert.ok(first.getInternalSnapshot());
  uid = "synthetic-other";
  assert.equal((await second.refresh()).status, "identity_mismatch");
  assert.equal(first.getInternalSnapshot(), null);
  db.close();
});

test("another session's failed refresh invalidates previously cached account data", async () => {
  const db = openDb(":memory:");
  let failing = false;
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => { if (failing) throw new Error("synthetic-upstream-sentinel"); return snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }); },
    close: async () => {},
  });
  const config = { scopeId: "scope:shared-failure", profile: "synthetic", site: "global" as const };
  const first = createDemoAccountSession(db, config, { now: () => AT, connect });
  const second = createDemoAccountSession(db, config, { now: () => AT, connect });
  assert.equal((await first.refresh()).status, "bound");
  assert.ok(first.getInternalSnapshot());
  failing = true;
  assert.equal((await second.refresh()).status, "unavailable");
  assert.equal(first.getInternalSnapshot(), null);
  db.close();
});

test("closing a faulty reader never leaks upstream errors", async () => {
  const db = openDb(":memory:");
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }),
    close: () => { throw new Error("synthetic-close-private-sentinel"); },
  });
  const session = createDemoAccountSession(db, { scopeId: "scope:close", profile: "synthetic", site: "global" }, { now: () => AT, connect });
  const result = await session.refresh();
  assert.equal(result.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /sentinel/);
  assert.equal(result.blockNewRisk, true);
  db.close();
});

test("scope binding and identity conflict survive closing and reopening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-demo-session-"));
  const dbPath = join(directory, "synthetic.sqlite");
  let db = openDb(dbPath);
  let uid = "synthetic-first";
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }, uid), close: async () => {},
  });
  const config = { scopeId: "scope:durable", profile: "synthetic", site: "global" as const };
  try {
    const session = createDemoAccountSession(db, config, { now: () => AT, connect });
    const bound = await session.refresh();
    assert.equal(bound.status, "bound");
    uid = "synthetic-other";
    assert.equal((await session.refresh()).status, "identity_mismatch");
    assert.throws(() => db.exec("DELETE FROM demo_account_identity_conflicts"));
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO demo_account_identity_conflicts(scope_id,observed_at) VALUES (?,?)").run(config.scopeId, AT.toISOString()));
    assert.throws(() => db.exec("UPDATE demo_account_scopes SET site='us'"));
    assert.throws(() => db.exec("DELETE FROM demo_account_refresh_events"));
    db.close();
    db = openDb(dbPath);
    uid = "synthetic-first";
    const restarted = createDemoAccountSession(db, config, { now: () => AT, connect });
    const stillLocked = await restarted.refresh();
    assert.equal(stillLocked.status, "identity_mismatch");
    assert.equal(stillLocked.accountRef, bound.accountRef);
    assert.equal(restarted.getInternalSnapshot(), null);
  } finally {
    if (db.isOpen) db.close();
    for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(target)) unlinkSync(target);
    rmdirSync(directory);
  }
});

test("wrong environment or site is unavailable and the private reader is closed", async () => {
  for (const scope of [
    { scopeId: "scope:wrong", site: "global", environment: "live" },
    { scopeId: "scope:wrong", site: "us", environment: "demo" },
    { scopeId: "scope:other", site: "global", environment: "demo" },
  ]) {
    const db = openDb(":memory:");
    let closed = 0;
    const connect = async () => ({ refresh: async () => snapshot(scope as DemoScope), close: async () => { closed += 1; } });
    const session = createDemoAccountSession(db, { scopeId: "scope:wrong", profile: "synthetic", site: "global" }, { now: () => AT, connect });
    const rejected = await session.refresh();
    assert.equal(rejected.status, "unavailable");
    assert.equal(rejected.blockNewRisk, true);
    assert.equal(session.getInternalSnapshot(), null);
    assert.equal(closed, 1);
    assert.doesNotMatch(JSON.stringify(rejected), /synthetic-uid-sentinel|12345\.6789/);
    db.close();
  }
});

test("concurrent refreshes do not expose a snapshot while the original read is pending", async () => {
  const db = openDb(":memory:");
  let complete: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  let calls = 0;
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => {
    calls += 1;
    return { refresh: async () => { await pending; return snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }); }, close: async () => {} };
  };
  const session = createDemoAccountSession(db, { scopeId: "scope:parallel", profile: "synthetic", site: "global" }, { now: () => AT, connect });
  const first = session.refresh();
  assert.equal((await session.refresh()).status, "unavailable");
  assert.equal(session.getInternalSnapshot(), null);
  assert.equal(calls, 1);
  complete!();
  assert.equal((await first).status, "bound");
  assert.ok(session.getInternalSnapshot());
  db.close();
});

test("a later session invalidates earlier data while pending and an older result cannot overwrite its failure", async () => {
  const db = openDb(":memory:");
  let finishOld: (() => void) | undefined;
  let oldStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { oldStarted = resolve; });
  const waitOld = new Promise<void>((resolve) => { finishOld = resolve; });
  const normal = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }), close: async () => {},
  });
  const config = { scopeId: "scope:ordered", profile: "synthetic", site: "global" as const };
  const prior = createDemoAccountSession(db, config, { now: () => AT, connect: normal });
  assert.equal((await prior.refresh()).status, "bound");
  const older = createDemoAccountSession(db, config, { now: () => AT, connect: async (input) => ({
    refresh: async () => { oldStarted!(); await waitOld; return snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }); }, close: async () => {},
  }) });
  const oldCall = older.refresh();
  await started;
  assert.equal(prior.getInternalSnapshot(), null, "a pending refresh invalidates cached data");
  const newer = createDemoAccountSession(db, config, { now: () => AT, connect: async () => { throw new Error("synthetic"); } });
  assert.equal((await newer.refresh()).status, "unavailable");
  finishOld!();
  assert.equal((await oldCall).status, "unavailable");
  assert.equal(older.getInternalSnapshot(), null);
  db.close();
});

test("snapshots stay unavailable until the reader closes successfully", async () => {
  const db = openDb(":memory:");
  let closeStarted: (() => void) | undefined;
  let finishClose: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { closeStarted = resolve; });
  const waitClose = new Promise<void>((resolve) => { finishClose = resolve; });
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }),
    close: async () => { closeStarted!(); await waitClose; },
  });
  const session = createDemoAccountSession(db, { scopeId: "scope:closing", profile: "synthetic", site: "global" }, { now: () => AT, connect });
  const pending = session.refresh();
  await started;
  assert.equal(session.getInternalSnapshot(), null);
  finishClose!();
  assert.equal((await pending).status, "bound");
  assert.ok(session.getInternalSnapshot());
  db.close();
});

test("read-only database failure invalidates old snapshots across sessions before any new exchange read", async () => {
  const db = openDb(":memory:");
  let calls = 0;
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => {
    calls += 1;
    return { refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }), close: async () => {} };
  };
  const config = { scopeId: "scope:readonly", profile: "synthetic", site: "global" as const };
  const first = createDemoAccountSession(db, config, { now: () => AT, connect });
  const second = createDemoAccountSession(db, config, { now: () => AT, connect });
  assert.equal((await first.refresh()).status, "bound");
  db.exec("PRAGMA query_only = ON");
  assert.equal((await second.refresh()).status, "unavailable");
  assert.equal(calls, 1);
  assert.equal(first.getInternalSnapshot(), null);
  db.exec("PRAGMA query_only = OFF");
  assert.equal(first.getInternalSnapshot(), null);
  db.close();
});

test("a connection-specific pre-read write failure never starts a read or grants risk authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-demo-session-"));
  const dbPath = join(directory, "synthetic.sqlite");
  const dbA = openDb(dbPath);
  const dbB = openDb(dbPath);
  let calls = 0;
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => {
    calls += 1;
    return { refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }), close: async () => {} };
  };
  const config = { scopeId: "scope:separate-db", profile: "synthetic", site: "global" as const };
  try {
    const first = createDemoAccountSession(dbA, config, { now: () => AT, connect });
    const second = createDemoAccountSession(dbB, config, { now: () => AT, connect });
    assert.equal((await first.refresh()).status, "bound");
    dbB.exec("PRAGMA query_only = ON");
    const rejected = await second.refresh();
    assert.equal(rejected.status, "unavailable");
    assert.equal(rejected.blockNewRisk, true);
    assert.equal(calls, 1, "the second connection never starts the exchange read");
    const prior = first.getInternalSnapshot();
    assert.equal(prior?.blockNewRisk, true);
    assert.equal(prior?.executionAuthorized, false);
    assert.equal(prior?.reconciled, false);
  } finally {
    dbA.close(); dbB.close();
    for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(target)) unlinkSync(target);
    rmdirSync(directory);
  }
});

test("wall clock rollback and real elapsed time cannot extend snapshot validity", async () => {
  const db = openDb(":memory:");
  let wall = AT.getTime();
  let mono = 1000;
  const connect = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }), close: async () => {},
  });
  const options = { now: () => new Date(wall), monotonic: () => mono, connect };
  const session = createDemoAccountSession(db, { scopeId: "scope:clock", profile: "synthetic", site: "global" }, options);
  assert.equal((await session.refresh()).status, "bound");
  wall += 20_000; mono += 20_000;
  assert.ok(session.getInternalSnapshot());
  wall -= 19_000; mono += 1_000;
  assert.equal(session.getInternalSnapshot(), null);
  db.close();
});

test("an older successful read cannot replace a newer completed refresh", async () => {
  const db = openDb(":memory:");
  let beginOld: (() => void) | undefined;
  let finishOld: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { beginOld = resolve; });
  const waiting = new Promise<void>((resolve) => { finishOld = resolve; });
  const config = { scopeId: "scope:newer", profile: "synthetic", site: "global" as const };
  const older = createDemoAccountSession(db, config, { now: () => AT, connect: async (input) => ({
    refresh: async () => { beginOld!(); await waiting; return snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }); }, close: async () => {},
  }) });
  const newer = createDemoAccountSession(db, config, { now: () => AT, connect: async (input) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }), close: async () => {},
  }) });
  const oldCall = older.refresh();
  await started;
  assert.equal((await newer.refresh()).status, "bound");
  finishOld!();
  assert.equal((await oldCall).status, "unavailable");
  assert.equal(older.getInternalSnapshot(), null);
  assert.ok(newer.getInternalSnapshot());
  db.close();
});

test("a superseded read that detects a different identity still locks the bound scope", async () => {
  const db = openDb(":memory:");
  let beginOld: (() => void) | undefined;
  let finishOld: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { beginOld = resolve; });
  const waiting = new Promise<void>((resolve) => { finishOld = resolve; });
  const config = { scopeId: "scope:mismatch-late", profile: "synthetic", site: "global" as const };
  const normal = async (input: { scopeId: string; site: DemoScope["site"] }) => ({
    refresh: async () => snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }, "synthetic-original"), close: async () => {},
  });
  const newer = createDemoAccountSession(db, config, { now: () => AT, connect: normal });
  assert.equal((await newer.refresh()).status, "bound");
  const older = createDemoAccountSession(db, config, { now: () => AT, connect: async (input) => ({
    refresh: async () => { beginOld!(); await waiting; return snapshot({ scopeId: input.scopeId, site: input.site, environment: "demo" }, "synthetic-different"); }, close: async () => {},
  }) });
  const oldCall = older.refresh();
  await started;
  assert.equal((await newer.refresh()).status, "bound");
  assert.ok(newer.getInternalSnapshot());
  finishOld!();
  assert.equal((await oldCall).status, "identity_mismatch");
  assert.equal(newer.getInternalSnapshot(), null);
  db.close();
});
