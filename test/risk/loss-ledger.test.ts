import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { openDb, type Db } from "../../src/store/db.ts";
import { SCHEMA } from "../../src/store/schema.ts";
import { hashJson } from "../../src/lib/hash.ts";
import { initializeLossScope, observeEquity, recordConfirmedCapitalEvent, type LossPolicy } from "../../src/risk/loss-ledger.ts";
import { expectDomainError } from "../helpers/assertions.ts";

const policy: LossPolicy = {
  id: "synthetic-policy",
  version: 1,
  initialEquityUsdt: "500",
  budgetsUsdt: { reserve: "300", spot: "150", perpetual: "50" },
  lossLinesUsdt: { review: "25", pause: "60", stop: "120" },
};

test("a tiny budget excess over the baseline is rejected", () => {
  const db = openDb(":memory:");
  const excessive = { ...policy, initialEquityUsdt: "1", budgetsUsdt: { reserve: "1", spot: `0.${"0".repeat(50)}1`, perpetual: "0" }, lossLinesUsdt: { review: "0.1", pause: "0.2", stop: "0.3" } };
  expectDomainError(() => initializeLossScope(db, { scopeId: "tiny-excess", baselineRef: "b", at: "2026-10-28T00:00:00Z", policy: excessive }), "INVALID_INPUT", { ruleId: "risk.budgets_within_baseline" });
  db.close();
});

test("ledger rejects oversize policy and observation amounts", () => {
  const oversize = `0.${"0".repeat(255)}1`;
  const db = openDb(":memory:");
  expectDomainError(() => initializeLossScope(db, { scopeId: "oversize", baselineRef: "b", at: "2026-10-28T00:00:00Z", policy: { ...policy, initialEquityUsdt: oversize } }), "INVALID_INPUT", { ruleId: "risk.schema" });
  db.close();
  const fixture = setup();
  expectDomainError(() => fixture.observe(oversize), "INVALID_INPUT", { ruleId: "risk.decimal" });
  assert.throws(() => fixture.db.exec("DELETE FROM risk_loss_scope_arithmetic"), /immutable/);
  assert.throws(() => fixture.db.exec("UPDATE risk_loss_scope_arithmetic SET version = 2"), /immutable/);
  fixture.db.close();
});

test("legacy arithmetic scopes stay locked even when an old observation is replayed", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO risk_loss_scopes (id, policy_id, policy_version, policy_hash, policy_json, baseline_ref, baseline_at, baseline_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy", policy.id, policy.version, "legacy-hash", JSON.stringify(policy), "baseline", "2026-10-28T00:00:00Z", Date.parse("2026-10-28T00:00:00Z"));
  const input = { scopeId: "legacy", sourceRef: "old", observedAt: "2026-10-28T00:01:00Z", equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true };
  // Simulate a row written before the upgraded guard existed, then restore it.
  db.exec("DROP TRIGGER risk_equity_observations_write_guard");
  db.prepare("INSERT INTO risk_equity_observations (id, scope_id, source_ref, observed_at, observed_ms, equity_usdt, account_reconciled, capital_history_reconciled, input_hash, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("old-id", "legacy", "old", input.observedAt, Date.parse(input.observedAt), "500", 1, 1, hashJson(input), JSON.stringify({ blockNewRisk: false }));
  const guard = SCHEMA.find((sql) => sql.includes("CREATE TRIGGER IF NOT EXISTS risk_equity_observations_write_guard"));
  assert.ok(guard);
  db.exec(guard);
  expectDomainError(() => observeEquity(db, input), "INVALID_INPUT", { ruleId: "risk.legacy_arithmetic_requires_review" });
  expectDomainError(() => recordConfirmedCapitalEvent(db, { scopeId: "legacy", exchangeRef: "c", kind: "deposit", amountUsdt: "1", occurredAt: "2026-10-28T00:00:10Z" }), "INVALID_INPUT", { ruleId: "risk.legacy_arithmetic_requires_review" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_loss_scopes").get()?.n, 1);
  db.close();
});

test("old-version writers cannot insert observations or capital into a current scope", () => {
  const { db, scopeId } = setup();
  assert.throws(() => db.prepare("INSERT INTO risk_equity_observations (id, scope_id, source_ref, observed_at, observed_ms, equity_usdt, account_reconciled, capital_history_reconciled, input_hash, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("old-version-observation", scopeId, "old-version", "2026-10-28T00:01:00Z", Date.parse("2026-10-28T00:01:00Z"), "500", 1, 1, "hash", "{}"), /arithmetic write guard/);
  assert.throws(() => db.prepare("INSERT INTO risk_capital_events (id, scope_id, exchange_ref, kind, amount_usdt, occurred_at, occurred_ms, input_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("old-version-capital", scopeId, "old-capital", "deposit", "1", "2026-10-28T00:00:10Z", Date.parse("2026-10-28T00:00:10Z"), "hash"), /arithmetic write guard/);
  db.close();
});

test("a separate old-style process cannot write to a current ledger", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-old-writer-"));
  const resolved = realpathSync(directory);
  const withinTemp = relative(realpathSync(tmpdir()), resolved);
  assert.ok(withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp));
  const path = join(resolved, "ledger.db");
  const db = openDb(path);
  t.after(() => { db.close(); rmSync(resolved, { recursive: true, force: true }); });
  initializeLossScope(db, { scopeId: "scope", policy, baselineRef: "b", at: "2026-10-28T00:00:00Z" });
  const oldWriter = `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    try {
      db.prepare("INSERT INTO risk_equity_observations (id, scope_id, source_ref, observed_at, observed_ms, equity_usdt, account_reconciled, capital_history_reconciled, input_hash, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run('old-id', 'scope', 'old-source', '2026-10-28T00:01:00Z', 1793145660000, '500', 1, 1, 'hash', '{}');
      process.exitCode = 2;
    } catch (error) {
      if (!String(error).includes('risk arithmetic write guard')) process.exitCode = 3;
    } finally { db.close(); }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", oldWriter, path], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_equity_observations").get()?.n, 0);
});

test("write authorization and scope markers roll back with their protected records", () => {
  const db = openDb(":memory:");
  db.exec("CREATE TRIGGER fail_scope_marker BEFORE INSERT ON risk_loss_scope_arithmetic BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => initializeLossScope(db, { scopeId: "failed-scope", policy, baselineRef: "b", at: "2026-10-28T00:00:00Z" }), /injected failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_loss_scopes").get()?.n, 0);
  db.exec("DROP TRIGGER fail_scope_marker");
  initializeLossScope(db, { scopeId: "scope", policy, baselineRef: "b", at: "2026-10-28T00:00:00Z" });
  db.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON risk_equity_observations BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => observeEquity(db, { scopeId: "scope", sourceRef: "one", observedAt: "2026-10-28T00:01:00Z", equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true }), /injected failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_loss_write_authorizations").get()?.n, 0);
  db.exec("DROP TRIGGER fail_observation");
  const result = observeEquity(db, { scopeId: "scope", sourceRef: "one", observedAt: "2026-10-28T00:01:00Z", equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true });
  assert.equal(result.state, "active");
  db.close();
});

function setup(scopeId = "synthetic-scope") {
  const db = openDb(":memory:");
  const policyHash = initializeLossScope(db, { scopeId, policy, baselineRef: "baseline-reconciled-1", at: "2026-10-28T00:00:00Z" });
  let index = 0;
  const observe = (equityUsdt: string, options: Partial<Parameters<typeof observeEquity>[1]> = {}) => {
    index += 1;
    return observeEquity(db, {
      scopeId,
      sourceRef: `snapshot-${index}`,
      observedAt: `2026-10-28T00:${String(index).padStart(2, "0")}:00Z`,
      equityUsdt,
      accountReconciled: true,
      capitalHistoryReconciled: true,
      ...options,
    });
  };
  return { db, policyHash, observe, scopeId };
}

test("late capital durably blocks replay and new observations while other capital can still be recorded", () => {
  const {db,scopeId,observe}=setup();
  const before=observe("500"); assert.equal(before.blockNewRisk,false);
  const late={scopeId,exchangeRef:"late-deposit",kind:"deposit" as const,amountUsdt:"70",occurredAt:"2026-10-28T00:01:00Z"};
  const id=recordConfirmedCapitalEvent(db,late); assert.equal(recordConfirmedCapitalEvent(db,late),id);
  expectDomainError(()=>observeEquity(db,{scopeId,sourceRef:"snapshot-1",observedAt:before.observedAt,equityUsdt:"500",accountReconciled:true,capitalHistoryReconciled:true}),"DATA_NOT_READY",{ruleId:"risk.capital_history_late"});
  expectDomainError(()=>observe("570"),"DATA_NOT_READY",{ruleId:"risk.capital_history_late"});
  recordConfirmedCapitalEvent(db,{scopeId,exchangeRef:"later-capital",kind:"withdrawal",amountUsdt:"1",occurredAt:"2026-10-28T00:03:00Z"});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_capital_events").get()?.n,2);
  assert.throws(()=>db.exec("DELETE FROM risk_capital_reconciliation_locks"),/immutable/);
  assert.throws(()=>db.exec("UPDATE risk_capital_reconciliation_locks SET reason=reason"),/immutable/);
  assert.throws(()=>db.exec("INSERT OR REPLACE INTO risk_capital_reconciliation_locks SELECT * FROM risk_capital_reconciliation_locks"),/immutable/);
  db.close();
});

test("a prior observation cannot be replayed after a newer hard stop", () => {
  const {db,scopeId,observe}=setup(); const first=observe("500");
  assert.equal(observe("370").state,"hard_stopped");
  expectDomainError(()=>observeEquity(db,{scopeId,sourceRef:"snapshot-1",observedAt:first.observedAt,equityUsdt:"500",accountReconciled:true,capitalHistoryReconciled:true}),"DATA_NOT_READY",{ruleId:"risk.observation_stale"});
  assert.equal(observe("500").state,"hard_stopped"); db.close();
});

test("a newly recorded capital event after the latest observation makes that replay stale",()=>{
  const {db,scopeId,observe}=setup();const first=observe('500');
  recordConfirmedCapitalEvent(db,{scopeId,exchangeRef:'newer-capital',kind:'deposit',amountUsdt:'50',occurredAt:'2026-10-28T00:02:00Z'});
  const replay={scopeId,sourceRef:'snapshot-1',observedAt:first.observedAt,equityUsdt:'500',accountReconciled:true,capitalHistoryReconciled:true};
  expectDomainError(()=>observeEquity(db,replay),'DATA_NOT_READY',{ruleId:'risk.observation_before_capital'});
  const next=observe('550',{observedAt:'2026-10-28T00:02:00.001Z'});assert.equal(next.netPnlUsdt,'0');assert.equal(next.blockNewRisk,false);db.close();
});

test("capital recorded first at the same time as an observation makes that observation unusable",()=>{
  const {db,scopeId}=setup();
  recordConfirmedCapitalEvent(db,{scopeId,exchangeRef:'equal',kind:'deposit',amountUsdt:'50',occurredAt:'2026-10-28T00:01:00Z'});
  const equal={scopeId,sourceRef:'equal',observedAt:'2026-10-28T00:01:00Z',equityUsdt:'500',accountReconciled:true,capitalHistoryReconciled:true};
  expectDomainError(()=>observeEquity(db,equal),'DATA_NOT_READY',{ruleId:'risk.observation_before_capital'});
  const after=observeEquity(db,{...equal,sourceRef:'after',observedAt:'2026-10-28T00:01:00.001Z',equityUsdt:'550'});
  assert.equal(after.netPnlUsdt,'0');assert.equal(after.blockNewRisk,false);db.close();
});

test("capital recorded after an observation at the same time creates a durable late lock",()=>{
  const {db,scopeId,observe}=setup(); const first=observe('500');
  recordConfirmedCapitalEvent(db,{scopeId,exchangeRef:'equal',kind:'deposit',amountUsdt:'50',occurredAt:first.observedAt});
  const replay={scopeId,sourceRef:'snapshot-1',observedAt:first.observedAt,equityUsdt:'500',accountReconciled:true,capitalHistoryReconciled:true};
  expectDomainError(()=>observeEquity(db,replay),'DATA_NOT_READY',{ruleId:'risk.capital_history_late'});
  assert.equal(db.prepare('SELECT reason FROM risk_capital_reconciliation_locks WHERE scope_id=?').get(scopeId)?.reason,'late_capital');db.close();
});

test("an observation before already-recorded capital cannot be used as a current risk result",()=>{
  const {db,scopeId}=setup();
  recordConfirmedCapitalEvent(db,{scopeId,exchangeRef:'future-capital',kind:'deposit',amountUsdt:'50',occurredAt:'2026-10-28T00:02:00Z'});
  const before={scopeId,sourceRef:'before',observedAt:'2026-10-28T00:01:00Z',equityUsdt:'500',accountReconciled:true,capitalHistoryReconciled:true};
  expectDomainError(()=>observeEquity(db,before),'DATA_NOT_READY',{ruleId:'risk.observation_before_capital'});
  db.prepare("INSERT INTO risk_loss_write_authorizations (id,scope_id,kind) VALUES (?,?,'observation')").run('old-style',scopeId);
  assert.throws(()=>db.prepare("INSERT INTO risk_equity_observations (id,scope_id,source_ref,observed_at,observed_ms,equity_usdt,account_reconciled,capital_history_reconciled,input_hash,result_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('old-style',scopeId,'legacy','2026-10-28T00:01:00Z',Date.parse('2026-10-28T00:01:00Z'),'500',1,1,'hash','{}'),/observation does not follow known capital/);
  const after=observeEquity(db,{...before,sourceRef:'after',observedAt:'2026-10-28T00:03:00Z',equityUsdt:'550'});
  assert.equal(after.netPnlUsdt,'0');assert.equal(after.blockNewRisk,false);db.close();
});

test("migration 5 installs the future-capital guard on a v4 database without rewriting history",(t)=>{
  const dir=mkdtempSync(join(tmpdir(),'taoalpha-capital-v5-'));const resolved=realpathSync(dir);const rel=relative(realpathSync(tmpdir()),resolved);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));t.after(()=>rmSync(resolved,{recursive:true,force:true}));
  const path=join(resolved,'ledger.db');let db=openDb(path);
  initializeLossScope(db,{scopeId:'scope',policy,baselineRef:'baseline',at:'2026-10-28T00:00:00Z'});
  const before={scopeId:'scope',sourceRef:'before',observedAt:'2026-10-28T00:01:00Z',equityUsdt:'500',accountReconciled:true,capitalHistoryReconciled:true};
  const historical=observeEquity(db,before);
  recordConfirmedCapitalEvent(db,{scopeId:'scope',exchangeRef:'later',kind:'deposit',amountUsdt:'50',occurredAt:'2026-10-28T00:02:00Z'});
  db.exec('DROP TRIGGER risk_observation_before_capital_guard; DELETE FROM schema_migrations WHERE version=5');db.close();
  db=openDb(path);
  expectDomainError(()=>observeEquity(db,before),'DATA_NOT_READY',{ruleId:'risk.observation_before_capital'});
  const saved=JSON.parse(db.prepare('SELECT result_json FROM risk_equity_observations WHERE id=?').get(historical.observationId)!.result_json as string) as {netPnlUsdt:string};
  assert.equal(saved.netPnlUsdt,'0');
  const after=observeEquity(db,{...before,sourceRef:'after',observedAt:'2026-10-28T00:03:00Z',equityUsdt:'550'});
  assert.equal(after.netPnlUsdt,'0');assert.equal(after.blockNewRisk,false);db.close();
});

test("migration 6 replaces the earlier v5 guard so equal-time old-style writes are rejected",(t)=>{
  const dir=mkdtempSync(join(tmpdir(),'taoalpha-capital-v6-'));const resolved=realpathSync(dir);const rel=relative(realpathSync(tmpdir()),resolved);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));t.after(()=>rmSync(resolved,{recursive:true,force:true}));
  const path=join(resolved,'ledger.db');let db=openDb(path);
  initializeLossScope(db,{scopeId:'scope',policy,baselineRef:'baseline',at:'2026-10-28T00:00:00Z'});
  recordConfirmedCapitalEvent(db,{scopeId:'scope',exchangeRef:'capital',kind:'deposit',amountUsdt:'1',occurredAt:'2026-10-28T00:01:00Z'});
  db.exec(`DROP TRIGGER risk_observation_before_capital_guard;
    CREATE TRIGGER risk_observation_before_capital_guard BEFORE INSERT ON risk_equity_observations
    WHEN EXISTS (SELECT 1 FROM risk_capital_events WHERE scope_id=NEW.scope_id AND occurred_ms>NEW.observed_ms)
    BEGIN SELECT RAISE(ABORT,'old guard'); END;
    DELETE FROM schema_migrations WHERE version=6`);db.close();
  db=openDb(path);db.prepare("INSERT INTO risk_loss_write_authorizations (id,scope_id,kind) VALUES (?,?,'observation')").run('old-equal','scope');
  assert.throws(()=>db.prepare("INSERT INTO risk_equity_observations (id,scope_id,source_ref,observed_at,observed_ms,equity_usdt,account_reconciled,capital_history_reconciled,input_hash,result_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('old-equal','scope','old-source','2026-10-28T00:01:00Z',Date.parse('2026-10-28T00:01:00Z'),'501',1,1,'hash','{}'),/observation does not follow known capital/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_capital_events').get()?.n,1);
  db.close();
});

test("even the latest observation cannot replay as active if a later risk event exists",()=>{
  const {db,scopeId,observe}=setup();const first=observe("500");
  db.prepare("INSERT INTO risk_loss_events (id,scope_id,observation_id,kind,loss_usdt,created_at) VALUES (?,?,?,?,?,?)")
    .run('later-event',scopeId,first.observationId,'hard_stop','120','2026-10-28T00:02:00Z');
  expectDomainError(()=>observeEquity(db,{scopeId,sourceRef:'snapshot-1',observedAt:first.observedAt,equityUsdt:'500',accountReconciled:true,capitalHistoryReconciled:true}),'DATA_NOT_READY',{ruleId:'risk.observation_stale'});
  db.close();
});

test("late-capital lock persists on reopen and is scoped to the affected ledger",(t)=>{
  const dir=mkdtempSync(join(tmpdir(),"taoalpha-late-capital-")); const resolved=realpathSync(dir); const rel=relative(realpathSync(tmpdir()),resolved);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel)); t.after(()=>rmSync(resolved,{recursive:true,force:true}));
  const path=join(resolved,"ledger.db"); let db=openDb(path);
  for(const scopeId of ["a","b"]) initializeLossScope(db,{scopeId,policy,baselineRef:`baseline-${scopeId}`,at:"2026-10-28T00:00:00Z"});
  const observation={scopeId:"a",sourceRef:"before",observedAt:"2026-10-28T00:02:00Z",equityUsdt:"500",accountReconciled:true,capitalHistoryReconciled:true};
  observeEquity(db,observation);recordConfirmedCapitalEvent(db,{scopeId:"a",exchangeRef:"late",kind:"deposit",amountUsdt:"70",occurredAt:"2026-10-28T00:01:00Z"}); db.close();
  db=openDb(path); expectDomainError(()=>observeEquity(db,observation),"DATA_NOT_READY",{ruleId:"risk.capital_history_late"});
  const b=observeEquity(db,{...observation,scopeId:"b"});assert.equal(b.blockNewRisk,false); db.close();
});

test("failure to persist the late-capital lock rolls back the capital event",()=>{
  const {db,scopeId,observe}=setup();observe("500");
  db.exec("CREATE TRIGGER fail_late_capital BEFORE INSERT ON risk_capital_reconciliation_locks BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(()=>recordConfirmedCapitalEvent(db,{scopeId,exchangeRef:"late",kind:"deposit",amountUsdt:"70",occurredAt:"2026-10-28T00:00:30Z"}),/injected/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_capital_events").get()?.n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_capital_reconciliation_locks").get()?.n,0);
  db.close();
});

test("old-style inserts cannot append an observation after a late-capital lock",()=>{
  const {db,scopeId,observe}=setup();observe("500");
  // Simulate the immediately previous implementation, which already wrote its v2 authorization.
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO risk_loss_write_authorizations (id,scope_id,kind) VALUES (?,?,'capital')").run('old-capital',scopeId);
  db.prepare("INSERT INTO risk_capital_events (id,scope_id,exchange_ref,kind,amount_usdt,occurred_at,occurred_ms,input_hash) VALUES (?,?,?,?,?,?,?,?)")
    .run('old-capital',scopeId,'old-ref','deposit','1','2026-10-28T00:00:30Z',Date.parse('2026-10-28T00:00:30Z'),'synthetic-hash');
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT reason FROM risk_capital_reconciliation_locks WHERE scope_id=?").get(scopeId)?.reason,'late_capital');
  db.prepare("INSERT INTO risk_loss_write_authorizations (id,scope_id,kind) VALUES (?,?,'observation')").run('old-observation',scopeId);
  assert.throws(()=>db.prepare("INSERT INTO risk_equity_observations (id,scope_id,source_ref,observed_at,observed_ms,equity_usdt,account_reconciled,capital_history_reconciled,input_hash,result_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('old-observation',scopeId,'old-source','2026-10-28T00:02:00Z',Date.parse('2026-10-28T00:02:00Z'),'500',1,1,'hash','{}'),/capital reconciliation required/);
  db.close();
});

test("migration quarantines previously overlapping capital and observations when ingestion order is unknown",(t)=>{
  const dir=mkdtempSync(join(tmpdir(),"taoalpha-capital-migration-")); const resolved=realpathSync(dir); const rel=relative(realpathSync(tmpdir()),resolved);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));t.after(()=>rmSync(resolved,{recursive:true,force:true}));
  const path=join(resolved,"ledger.db");let db=openDb(path);
  initializeLossScope(db,{scopeId:"existing",policy,baselineRef:"b",at:"2026-10-28T00:00:00Z"});
  initializeLossScope(db,{scopeId:"future",policy,baselineRef:"f",at:"2026-10-28T00:00:00Z"});
  recordConfirmedCapitalEvent(db,{scopeId:"existing",exchangeRef:"capital",kind:"deposit",amountUsdt:"1",occurredAt:"2026-10-28T00:00:30Z"});
  const input={scopeId:"existing",sourceRef:"observation",observedAt:"2026-10-28T00:01:00Z",equityUsdt:"501",accountReconciled:true,capitalHistoryReconciled:true};
  assert.equal(observeEquity(db,input).blockNewRisk,false);
  observeEquity(db,{...input,scopeId:"future"});
  recordConfirmedCapitalEvent(db,{scopeId:"future",exchangeRef:"future-capital",kind:"deposit",amountUsdt:"1",occurredAt:"2026-10-28T00:02:00Z"});
  // Simulate the pre-migration v2 ledger, preserving scope, events, and observations.
  db.exec("DROP TRIGGER risk_late_capital_lock; DROP TRIGGER risk_observation_late_capital_guard; DROP TRIGGER risk_capital_locks_no_update; DROP TRIGGER risk_capital_locks_no_delete; DROP TABLE risk_capital_reconciliation_locks; DELETE FROM schema_migrations WHERE version=4");
  db.close();db=openDb(path);
  assert.equal(db.prepare("SELECT reason FROM risk_capital_reconciliation_locks WHERE scope_id=?").get("existing")?.reason,'pre_upgrade_order_unknown');
  assert.equal(db.prepare("SELECT reason FROM risk_capital_reconciliation_locks WHERE scope_id=?").get("future"),undefined);
  expectDomainError(()=>observeEquity(db,input),'DATA_NOT_READY',{ruleId:'risk.capital_history_late'});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_capital_events").get()?.n,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_equity_observations").get()?.n,2);db.close();
});

test("another connection cannot observe an unlocked ledger during late-capital commit",(t)=>{
  const dir=mkdtempSync(join(tmpdir(),"taoalpha-capital-lock-"));const resolved=realpathSync(dir);const rel=relative(realpathSync(tmpdir()),resolved);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel)); const path=join(resolved,"ledger.db");
  const a=openDb(path);const b=openDb(path);t.after(()=>{if(a.isTransaction)a.exec("ROLLBACK");a.close();b.close();rmSync(resolved,{recursive:true,force:true})});
  initializeLossScope(a,{scopeId:"shared",policy,baselineRef:"b",at:"2026-10-28T00:00:00Z"});
  const observation={scopeId:"shared",sourceRef:"first",observedAt:"2026-10-28T00:01:00Z",equityUsdt:"500",accountReconciled:true,capitalHistoryReconciled:true};
  observeEquity(a,observation);b.exec("PRAGMA busy_timeout=0");a.exec("BEGIN IMMEDIATE");
  a.prepare("INSERT INTO risk_loss_write_authorizations (id,scope_id,kind) VALUES (?,?,'capital')").run('inflight','shared');
  a.prepare("INSERT INTO risk_capital_events (id,scope_id,exchange_ref,kind,amount_usdt,occurred_at,occurred_ms,input_hash) VALUES (?,?,?,?,?,?,?,?)")
    .run('inflight','shared','inflight-ref','deposit','1','2026-10-28T00:00:30Z',Date.parse('2026-10-28T00:00:30Z'),'hash');
  assert.throws(()=>observeEquity(b,observation),/locked/);
  a.exec("COMMIT");expectDomainError(()=>observeEquity(b,observation),'DATA_NOT_READY',{ruleId:'risk.capital_history_late'});
});

test("loss lines are exact, persistent and prioritize hard-stop actions", () => {
  const { db, observe } = setup();
  assert.deepEqual([observe("475.01").state, observe("475").state], ["active", "review_needed"]);
  const pause = observe("440");
  assert.equal(pause.cumulativeLossUsdt, "60");
  assert.equal(pause.state, "soft_paused");
  assert.equal(pause.blockNewRisk, true);
  assert.deepEqual(pause.requiredActions, ["cancel_risk_increasing_entries", "review"]);
  const stop = observe("380");
  assert.equal(stop.cumulativeLossUsdt, "120");
  assert.equal(stop.state, "hard_stopped");
  assert.deepEqual(stop.requiredActions, ["cancel_risk_increasing_entries", "exit_managed_perpetuals", "review"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_loss_events").get()?.n, 3);
  assert.equal(observe("550").state, "hard_stopped", "a rebound cannot unlock the hard stop");
});

test("one observation may cross all three lines without delaying the hard-stop state", () => {
  const { observe } = setup();
  const view = observe("370");
  assert.equal(view.state, "hard_stopped");
  assert.equal(view.cumulativeLossUsdt, "130");
  assert.equal(view.eventIds.length, 3);
  assert.ok(view.requiredActions.includes("exit_managed_perpetuals"));
});

test("confirmed deposits and withdrawals adjust PnL exactly, with costs already included in equity", () => {
  const { db, observe, scopeId } = setup();
  const deposit = { scopeId, exchangeRef: "funding-deposit-1", kind: "deposit" as const, amountUsdt: "50", occurredAt: "2026-10-28T00:00:10Z" };
  const depositId = recordConfirmedCapitalEvent(db, deposit);
  assert.equal(recordConfirmedCapitalEvent(db, deposit), depositId);
  recordConfirmedCapitalEvent(db, { scopeId, exchangeRef: "funding-withdrawal-1", kind: "withdrawal", amountUsdt: "30", occurredAt: "2026-10-28T00:00:20Z" });
  const neutral = observe("520");
  assert.equal(neutral.netPnlUsdt, "0");
  assert.equal(neutral.cumulativeLossUsdt, "0");
  const loss = observe("400");
  assert.equal(loss.netPnlUsdt, "-120");
  assert.equal(loss.state, "hard_stopped");
  expectDomainError(() => recordConfirmedCapitalEvent(db, { ...deposit, amountUsdt: "60" }), "IDEMPOTENCY_CONFLICT", { ruleId: "risk.capital_ref_once" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_capital_events").get()?.n, 2);
});

test("profit after a high-water mark does not trigger an initial-capital loss line", () => {
  const { observe } = setup();
  assert.equal(observe("620").netPnlUsdt, "120");
  const later = observe("530");
  assert.equal(later.netPnlUsdt, "30");
  assert.equal(later.cumulativeLossUsdt, "0");
  assert.equal(later.state, "active");
  assert.equal(later.blockNewRisk, false);
});

test("a funding event after an equity snapshot cannot change that earlier snapshot's PnL", () => {
  const { db, scopeId } = setup();
  const before = observeEquity(db, { scopeId, sourceRef: "before", observedAt: "2026-10-28T00:01:00Z", equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true });
  assert.equal(before.netPnlUsdt, "0");
  recordConfirmedCapitalEvent(db, { scopeId, exchangeRef: "future-funding", kind: "deposit", amountUsdt: "50", occurredAt: "2026-10-28T00:03:00Z" });
  const stored = JSON.parse(db.prepare("SELECT result_json FROM risk_equity_observations WHERE id=?").get(before.observationId)!.result_json as string) as {netPnlUsdt:string};
  assert.equal(stored.netPnlUsdt,"0", "the historical PnL is not rewritten with later funding");
  expectDomainError(() => observeEquity(db, { scopeId, sourceRef: "before", observedAt: "2026-10-28T00:01:00Z", equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true }), "DATA_NOT_READY", { ruleId: "risk.observation_before_capital" });
  const after = observeEquity(db, { scopeId, sourceRef: "after", observedAt: "2026-10-28T00:04:00Z", equityUsdt: "550", accountReconciled: true, capitalHistoryReconciled: true });
  assert.equal(after.netPnlUsdt, "0");
  assert.equal(after.state, "active");
});

test("incomplete account or funding reconciliation blocks new risk without inventing a loss event", () => {
  const { db, observe } = setup();
  const incomplete = observe("370", { accountReconciled: false, capitalHistoryReconciled: false });
  assert.equal(incomplete.dataReady, false);
  assert.deepEqual(incomplete.missing, ["account_reconciliation", "capital_history_reconciliation"]);
  assert.equal(incomplete.netPnlUsdt, null);
  assert.equal(incomplete.blockNewRisk, true);
  assert.deepEqual(incomplete.requiredActions, ["reconcile_account", "reconcile_capital_history"]);
  assert.equal(incomplete.eventIds.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_loss_events").get()?.n, 0);
  assert.equal(observe("370").state, "hard_stopped");
});

test("observation identity, chronological order and immutability survive repeated calls", () => {
  const { db, observe, scopeId } = setup();
  const first = observe("475");
  const replay = observe("475", { sourceRef: "snapshot-1", observedAt: first.observedAt });
  assert.deepEqual(replay, first);
  expectDomainError(() => observeEquity(db, { scopeId, sourceRef: "snapshot-1", observedAt: first.observedAt, equityUsdt: "470", accountReconciled: true, capitalHistoryReconciled: true }), "IDEMPOTENCY_CONFLICT", { ruleId: "risk.observation_ref_once" });
  expectDomainError(() => observeEquity(db, { scopeId, sourceRef: "older", observedAt: first.observedAt, equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true }), "INVALID_INPUT", { ruleId: "risk.observation_time_increases" });
  assert.throws(() => db.exec("UPDATE risk_loss_events SET kind = 'hard_stop'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM risk_equity_observations"), /immutable/);
});

test("a fresh fall below and back above a line is a distinct event, while a persistent loss is not", () => {
  const { db, observe } = setup();
  observe("440");
  observe("420");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_loss_events WHERE kind = 'soft_pause'").get()?.n, 1);
  observe("450");
  observe("440");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_loss_events WHERE kind = 'soft_pause'").get()?.n, 2);
});

test("policies require ordered loss lines, bounded budgets and an immutable baseline", () => {
  const db = openDb(":memory:");
  expectDomainError(() => initializeLossScope(db, { scopeId: "x", baselineRef: "b", at: "2026-10-28T00:00:00Z", policy: { ...policy, lossLinesUsdt: { review: "60", pause: "25", stop: "120" } } }), "INVALID_INPUT", { ruleId: "risk.loss_lines_ordered" });
  expectDomainError(() => initializeLossScope(db, { scopeId: "x", baselineRef: "b", at: "2026-10-28T00:00:00Z", policy: { ...policy, budgetsUsdt: { reserve: "400", spot: "150", perpetual: "50" } } }), "INVALID_INPUT", { ruleId: "risk.budgets_within_baseline" });
  const input = { scopeId: "x", baselineRef: "baseline-1", at: "2026-10-28T00:00:00Z", policy };
  const hash = initializeLossScope(db, input);
  assert.equal(initializeLossScope(db, input), hash);
  expectDomainError(() => initializeLossScope(db, { ...input, baselineRef: "baseline-2" }), "IDEMPOTENCY_CONFLICT", { ruleId: "risk.scope_immutable" });
  expectDomainError(() => initializeLossScope(db, { ...input, at: "2026-10-28T00:00:01Z" }), "IDEMPOTENCY_CONFLICT", { ruleId: "risk.scope_immutable" });
  expectDomainError(() => recordConfirmedCapitalEvent(db, { scopeId: "x", exchangeRef: "old-deposit", kind: "deposit", amountUsdt: "10", occurredAt: "2026-10-27T23:59:59Z" }), "INVALID_INPUT", { ruleId: "risk.capital_after_baseline" });
  expectDomainError(() => observeEquity(db, { scopeId: "x", sourceRef: "old-equity", observedAt: "2026-10-27T23:59:59Z", equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true }), "INVALID_INPUT", { ruleId: "risk.observation_after_baseline" });
});

test("loss events remain after reopening the database and stay isolated by scope", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-loss-ledger-"));
  const resolved = realpathSync(directory);
  const withinTemp = relative(realpathSync(tmpdir()), resolved);
  assert.ok(withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp));
  t.after(() => rmSync(resolved, { recursive: true, force: true }));
  const path = join(directory, "ledger.db");
  const db = openDb(path);
  initializeLossScope(db, { scopeId: "scope-a", policy, baselineRef: "baseline-a", at: "2026-10-28T00:00:00Z" });
  initializeLossScope(db, { scopeId: "scope-b", policy, baselineRef: "baseline-b", at: "2026-10-28T00:00:00Z" });
  observeEquity(db, { scopeId: "scope-a", sourceRef: "a-1", observedAt: "2026-10-28T00:01:00Z", equityUsdt: "380", accountReconciled: true, capitalHistoryReconciled: true });
  db.close();
  const reopened = openDb(path);
  const b = observeEquity(reopened, { scopeId: "scope-b", sourceRef: "b-1", observedAt: "2026-10-28T00:01:00Z", equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true });
  assert.equal(b.state, "active");
  const a = observeEquity(reopened, { scopeId: "scope-a", sourceRef: "a-2", observedAt: "2026-10-28T00:02:00Z", equityUsdt: "510", accountReconciled: true, capitalHistoryReconciled: true });
  assert.equal(a.state, "hard_stopped");
  reopened.close();
});
