import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashJson } from "../lib/hash.ts";
import { DomainError } from "../lib/errors.ts";
import { getRow, inTransaction, type Db } from "../store/db.ts";
import { connectTradeKitDemoReader } from "../okx/trade-kit-transport.ts";
import type { DemoReadSnapshot, DemoSite } from "../okx/trade-kit-demo-reader.ts";
import { DEMO_ACCOUNT_GAPS, normalizeDemoAccount, type DemoAccount } from "./demo-account.ts";

const configSchema = z.object({
  scopeId: z.string().regex(/^scope:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  site: z.enum(["global", "eea", "us", "tr"]),
}).strict();
type Reader = { refresh(): Promise<DemoReadSnapshot>; close(): Promise<void> };
type Connect = (input: { scopeId: string; profile: string; site: DemoSite }) => Promise<Reader>;
interface BindingRow { scope_id: string; account_ref: string; site: DemoSite; identity_hash: string }
interface InternalSnapshot {
  scopeId: string;
  accountRef: string;
  site: DemoSite;
  environment: "demo";
  account: { config: Omit<DemoAccount["config"], "uid">; equity: DemoAccount["equity"]; positions: DemoAccount["positions"] };
  observedAt: string;
  validUntilMs: number;
  generation: number;
  reconciled: false;
  executionAuthorized: false;
  blockNewRisk: true;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS demo_account_scopes (
    scope_id TEXT PRIMARY KEY, account_ref TEXT NOT NULL UNIQUE, site TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment = 'demo'), identity_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(site, environment, identity_hash)
  )`,
  `CREATE TRIGGER IF NOT EXISTS demo_account_scopes_no_update BEFORE UPDATE ON demo_account_scopes BEGIN SELECT RAISE(ABORT, 'scope immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS demo_account_scopes_no_delete BEFORE DELETE ON demo_account_scopes BEGIN SELECT RAISE(ABORT, 'scope immutable'); END`,
  `CREATE TABLE IF NOT EXISTS demo_account_identity_conflicts (
    scope_id TEXT PRIMARY KEY REFERENCES demo_account_scopes(scope_id), observed_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS demo_account_identity_conflicts_no_update BEFORE UPDATE ON demo_account_identity_conflicts BEGIN SELECT RAISE(ABORT, 'conflict immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS demo_account_identity_conflicts_no_delete BEFORE DELETE ON demo_account_identity_conflicts BEGIN SELECT RAISE(ABORT, 'conflict immutable'); END`,
  `CREATE TABLE IF NOT EXISTS demo_account_refresh_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','ok','unavailable','identity_mismatch')), observed_at TEXT
  )`,
  `CREATE TRIGGER IF NOT EXISTS demo_account_refresh_events_no_update BEFORE UPDATE ON demo_account_refresh_events BEGIN SELECT RAISE(ABORT, 'refresh event immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS demo_account_refresh_events_no_delete BEFORE DELETE ON demo_account_refresh_events BEGIN SELECT RAISE(ABORT, 'refresh event immutable'); END`,
  `CREATE TABLE IF NOT EXISTS demo_account_write_probe (scope_id TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
];

/** Backend-only account scope. Constructor options are owned by the process, not a research request. */
export function createDemoAccountSession(db: Db, config: { scopeId: string; profile: string; site: DemoSite },
  options: { now?: () => Date; monotonic?: () => number; connect?: Connect } = {}) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "Invalid demo scope configuration", [{ ruleId: "account.scope_config" }]);
  const { scopeId, profile, site } = parsed.data;
  const now = options.now ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => performance.now());
  const connect = options.connect ?? connectTradeKitDemoReader;
  inTransaction(db, () => { for (const statement of SCHEMA) db.exec(statement); });
  const stored = () => getRow<BindingRow>(db, "SELECT scope_id,account_ref,site,identity_hash FROM demo_account_scopes WHERE scope_id = ?", scopeId);
  const existing = stored();
  if (existing && existing.site !== site) throw new DomainError("INVALID_INPUT", "Demo scope cannot change site", [{ ruleId: "account.scope_site" }]);
  let current: InternalSnapshot | null = null;
  let clockState: { wall: number; mono: number; lastWall: number; lastMono: number; expiresMono: number } | null = null;
  let refreshing = false;
  function recordEvent(status: "pending" | "ok" | "unavailable" | "identity_mismatch", at: string | null): number {
    const inserted = db.prepare("INSERT INTO demo_account_refresh_events(scope_id,status,observed_at) VALUES (?,?,?)").run(scopeId, status, at);
    const generation = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("invalid generation");
    return generation;
  }
  function latestEvent() {
    return getRow<{ seq: number; status: string }>(db, "SELECT seq,status FROM demo_account_refresh_events WHERE scope_id = ? ORDER BY seq DESC LIMIT 1", scopeId);
  }
  function unavailable(pendingGeneration: number) {
    current = null;
    clockState = null;
    try {
      inTransaction(db, () => {
        const latest = latestEvent();
        if (latest?.seq !== pendingGeneration || latest.status !== "pending") return;
        let at: string | null = null;
        try { at = now().toISOString(); } catch { /* Preserve the failure without inventing a timestamp. */ }
        recordEvent("unavailable", at);
      });
    } catch { /* Failed persistence cannot authorize a snapshot. */ }
    return result("unavailable", null);
  }

  return {
    async refresh() {
      current = null;
      clockState = null;
      if (refreshing) return result("unavailable", null);
      refreshing = true;
      let reader: Reader | undefined;
      let pendingGeneration: number;
      try {
        pendingGeneration = inTransaction(db, () => {
          const binding = stored();
          if (binding && binding.site !== site) throw new Error("scope mismatch");
          return recordEvent("pending", now().toISOString());
        });
      } catch {
        refreshing = false;
        return result("unavailable", null);
      }
      try {
        reader = await connect({ scopeId, profile, site });
        const raw = await reader.refresh();
        if (raw.scope.scopeId !== scopeId || raw.scope.site !== site || raw.scope.environment !== "demo") throw new Error("scope mismatch");
        // Do not publish successful state until the private credential-owning reader is closed.
        const closing = reader;
        reader = undefined;
        await closing.close();
        const at = now();
        const mono = monotonic();
        if (!Number.isFinite(at.getTime()) || !Number.isFinite(mono)) return unavailable(pendingGeneration);
        const normalized = normalizeDemoAccount(raw, at);
        if (!normalized.ok) return unavailable(pendingGeneration);
        const identity = hashJson({ site, environment: "demo", uid: normalized.account.config.uid });
        const binding = inTransaction(db, () => {
          const current = stored();
          const conflict = getRow(db, "SELECT scope_id FROM demo_account_identity_conflicts WHERE scope_id = ?", scopeId);
          if (current && conflict) {
            recordEvent("identity_mismatch", at.toISOString());
            return { response: result("identity_mismatch", current.account_ref), generation: null };
          }
          if (current && (current.site !== site || current.identity_hash !== identity)) {
            db.prepare("INSERT INTO demo_account_identity_conflicts(scope_id,observed_at) VALUES (?,?)").run(scopeId, at.toISOString());
            recordEvent("identity_mismatch", at.toISOString());
            return { response: result("identity_mismatch", current.account_ref), generation: null };
          }
          const latest = latestEvent();
          if (latest?.seq !== pendingGeneration || latest.status !== "pending") return { response: result("unavailable", null), generation: null };
          const duplicate = getRow<BindingRow>(db, "SELECT scope_id,account_ref,site,identity_hash FROM demo_account_scopes WHERE site = ? AND environment = 'demo' AND identity_hash = ?", site, identity);
          if (duplicate && duplicate.scope_id !== scopeId) {
            recordEvent("unavailable", at.toISOString());
            return { response: result("identity_conflict", null), generation: null };
          }
          const accountRef = current?.account_ref ?? `account:${randomUUID()}`;
          if (!current) db.prepare("INSERT INTO demo_account_scopes(scope_id,account_ref,site,environment,identity_hash,created_at) VALUES (?,?,?,'demo',?,?)")
            .run(scopeId, accountRef, site, identity, at.toISOString());
          return { response: result("bound", accountRef), generation: recordEvent("ok", at.toISOString()) };
        });
        if (binding.response.status === "bound" && binding.response.accountRef && binding.generation !== null) {
          // The oldest page limits freshness; individual sources are not an atomic exchange snapshot.
          const pageTimes = Object.values(raw.parts).flatMap((part) => part.status === "ok" ? part.pages.map((page) => Date.parse(page.requestTime)) : []);
          const { accountLevel, positionMode } = normalized.account.config;
          current = structuredClone({ scopeId, accountRef: binding.response.accountRef, site, environment: "demo" as const,
            account: { config: { accountLevel, positionMode }, equity: normalized.account.equity, positions: normalized.account.positions },
            observedAt: at.toISOString(), validUntilMs: Math.min(...pageTimes) + 30_000, generation: binding.generation,
            reconciled: false as const, executionAuthorized: false as const, blockNewRisk: true as const });
          clockState = { wall: at.getTime(), mono, lastWall: at.getTime(), lastMono: mono,
            expiresMono: mono + Math.min(30_000, current.validUntilMs - at.getTime()) };
        }
        return binding.response;
      } catch {
        return unavailable(pendingGeneration);
      } finally {
        try { await reader?.close(); } catch { /* Already unavailable; never expose provider diagnostics. */ }
        finally { refreshing = false; }
      }
    },
    /** Private backend state, never register this method as a research/MCP tool. */
    getInternalSnapshot(): InternalSnapshot | null {
      try {
        const at = now().getTime();
        const mono = monotonic();
        if (!current || !clockState) return null;
        if (!Number.isFinite(at) || !Number.isFinite(mono) || at < clockState.lastWall || mono < clockState.lastMono ||
          at > current.validUntilMs || mono > clockState.expiresMono ||
          Math.abs((at - clockState.wall) - (mono - clockState.mono)) > 5000) { current = null; clockState = null; return null; }
        // Commit a local write probe: a readable but non-writable ledger cannot supply usable state.
        const valid = inTransaction(db, () => {
          db.prepare("INSERT INTO demo_account_write_probe(scope_id,value) VALUES (?,1) ON CONFLICT(scope_id) DO UPDATE SET value = 1 - value").run(scopeId);
          const binding = stored();
          const latest = latestEvent();
          return !!binding && binding.account_ref === current!.accountRef && binding.site === current!.site &&
            latest?.seq === current!.generation && latest.status === "ok" &&
            !getRow(db, "SELECT scope_id FROM demo_account_identity_conflicts WHERE scope_id = ?", scopeId);
        });
        if (!valid) { current = null; clockState = null; return null; }
        clockState.lastWall = at;
        clockState.lastMono = mono;
        return structuredClone(current);
      } catch { current = null; clockState = null; return null; }
    },
  };
}

function result(status: "bound" | "unavailable" | "identity_mismatch" | "identity_conflict", accountRef: string | null) {
  return { status, accountRef, environment: "demo" as const, reconciled: false as const,
    executionAuthorized: false as const, blockNewRisk: true as const, missing: [...DEMO_ACCOUNT_GAPS] };
}
