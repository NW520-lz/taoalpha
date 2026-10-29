import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { openDb, type Db } from "../../src/store/db.ts";
import { initializeLossScope, observeEquity, recordConfirmedCapitalEvent, type LossPolicy } from "../../src/risk/loss-ledger.ts";
import { expectDomainError } from "../helpers/assertions.ts";

const policy: LossPolicy = {
  id: "synthetic-policy",
  version: 1,
  initialEquityUsdt: "500",
  budgetsUsdt: { reserve: "300", spot: "150", perpetual: "50" },
  lossLinesUsdt: { review: "25", pause: "60", stop: "120" },
};

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
  recordConfirmedCapitalEvent(db, { scopeId, exchangeRef: "future-funding", kind: "deposit", amountUsdt: "50", occurredAt: "2026-10-28T00:03:00Z" });
  const before = observeEquity(db, { scopeId, sourceRef: "before", observedAt: "2026-10-28T00:01:00Z", equityUsdt: "500", accountReconciled: true, capitalHistoryReconciled: true });
  assert.equal(before.netPnlUsdt, "0");
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
