import { z } from "zod";
import { DomainError } from "../lib/errors.ts";
import { Decimal, dec, isDecimalString } from "./risk-decimal.ts";
import { hashJson } from "../lib/hash.ts";
import { newId } from "../lib/ids.ts";
import { allRows, getRow, inTransaction, type Db } from "../store/db.ts";

const nonempty = z.string().trim().min(1);
const atTime = z.iso.datetime({ offset: true });
const money = z.string().refine(isDecimalString, "must be a plain decimal string");

const policySchema = z.object({
  id: nonempty,
  version: z.number().int().positive(),
  initialEquityUsdt: money,
  budgetsUsdt: z.object({ reserve: money, spot: money, perpetual: money }).strict(),
  lossLinesUsdt: z.object({ review: money, pause: money, stop: money }).strict(),
}).strict();

export type LossPolicy = z.infer<typeof policySchema>;
export type LossEventKind = "review" | "soft_pause" | "hard_stop";
export type LossState = "active" | "review_needed" | "soft_paused" | "hard_stopped";

export interface LossObservation {
  observationId: string;
  scopeId: string;
  policyHash: string;
  observedAt: string;
  dataReady: boolean;
  missing: Array<"account_reconciliation" | "capital_history_reconciliation">;
  netPnlUsdt: string | null;
  cumulativeLossUsdt: string | null;
  state: LossState;
  blockNewRisk: boolean;
  eventIds: string[];
  requiredActions: Array<"reconcile_account" | "reconcile_capital_history" | "review" | "cancel_risk_increasing_entries" | "exit_managed_perpetuals">;
}

interface ScopeRow { id: string; policy_hash: string; policy_json: string; baseline_ref: string; baseline_at: string; baseline_ms: number }
interface CapitalRow { id: string; input_hash: string; kind: "deposit" | "withdrawal"; amount_usdt: string }
interface ObservationRow { id: string; observed_ms: number; result_json: string; input_hash: string }
interface LossEventRow { id: string; kind: LossEventKind }

/** `at` is the reconciled baseline time. Only subsequent capital events affect PnL. */
export function initializeLossScope(db: Db, input: { scopeId: string; policy: LossPolicy; baselineRef: string; at: string }): string {
  const policy = parse(policySchema, input.policy, "risk.policy");
  const scopeId = required(input.scopeId, "scopeId");
  const baselineRef = required(input.baselineRef, "baselineRef");
  const at = timestamp(input.at, "at");
  validatePolicy(policy);
  const policyHash = hashJson(policy);
  return inTransaction(db, () => {
    const existing = getRow<ScopeRow>(db, "SELECT * FROM risk_loss_scopes WHERE id = ?", scopeId);
    if (existing) {
      requireCurrentArithmetic(db, scopeId);
      if (existing.policy_hash !== policyHash || existing.baseline_ref !== baselineRef || existing.baseline_at !== at) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "scope baseline or risk policy differs from the stored version", [{ ruleId: "risk.scope_immutable", field: "scopeId" }]);
      }
      return existing.policy_hash;
    }
    db.prepare("INSERT INTO risk_loss_scopes (id, policy_id, policy_version, policy_hash, policy_json, baseline_ref, baseline_at, baseline_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(scopeId, policy.id, policy.version, policyHash, JSON.stringify(policy), baselineRef, at, Date.parse(at));
    db.prepare("INSERT INTO risk_loss_scope_arithmetic (scope_id, version) VALUES (?, 2)").run(scopeId);
    return policyHash;
  });
}

/** Called only with a reconciled exchange funding reference; no Agent-facing write endpoint exists. */
export function recordConfirmedCapitalEvent(db: Db, input: {
  scopeId: string;
  exchangeRef: string;
  kind: "deposit" | "withdrawal";
  amountUsdt: string;
  occurredAt: string;
}): string {
  const scopeId = required(input.scopeId, "scopeId");
  const exchangeRef = required(input.exchangeRef, "exchangeRef");
  if (input.kind !== "deposit" && input.kind !== "withdrawal") invalid("risk.capital_kind", "kind");
  const amount = decimal(input.amountUsdt, "amountUsdt");
  if (!amount.gt(0)) invalid("risk.capital_positive", "amountUsdt");
  const occurredAt = timestamp(input.occurredAt, "occurredAt");
  const event = { scopeId, exchangeRef, kind: input.kind, amountUsdt: amount.toFixed(), occurredAt };
  const inputHash = hashJson(event);
  return inTransaction(db, () => {
    const scope = requireScope(db, scopeId);
    if (Date.parse(occurredAt) <= scope.baseline_ms) {
      throw new DomainError("INVALID_INPUT", "capital event must occur after the baseline", [{ ruleId: "risk.capital_after_baseline", field: "occurredAt" }]);
    }
    const existing = getRow<CapitalRow>(db, "SELECT id, input_hash, kind, amount_usdt FROM risk_capital_events WHERE scope_id = ? AND exchange_ref = ?", scopeId, exchangeRef);
    if (existing) {
      if (existing.input_hash !== inputHash) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "the exchange funding reference was already recorded with different content", [{ ruleId: "risk.capital_ref_once", field: "exchangeRef" }]);
      }
      return existing.id;
    }
    const id = newId("capital");
    db.prepare("INSERT INTO risk_loss_write_authorizations (id, scope_id, kind) VALUES (?, ?, 'capital')").run(id, scopeId);
    db.prepare("INSERT INTO risk_capital_events (id, scope_id, exchange_ref, kind, amount_usdt, occurred_at, occurred_ms, input_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, scopeId, exchangeRef, input.kind, amount.toFixed(), occurredAt, Date.parse(occurredAt), inputHash);
    return id;
  });
}

/** Persist one observed account equity and the loss-line events it crosses. This never sends exchange orders. */
export function observeEquity(db: Db, input: {
  scopeId: string;
  sourceRef: string;
  observedAt: string;
  equityUsdt: string;
  accountReconciled: boolean;
  capitalHistoryReconciled: boolean;
}): LossObservation {
  const scopeId = required(input.scopeId, "scopeId");
  const sourceRef = required(input.sourceRef, "sourceRef");
  const observedAt = timestamp(input.observedAt, "observedAt");
  const observedMs = Date.parse(observedAt);
  const equity = decimal(input.equityUsdt, "equityUsdt");
  if (typeof input.accountReconciled !== "boolean" || typeof input.capitalHistoryReconciled !== "boolean") {
    invalid("risk.reconciliation_flag", "accountReconciled");
  }
  const normalized = { scopeId, sourceRef, observedAt, equityUsdt: equity.toFixed(), accountReconciled: input.accountReconciled, capitalHistoryReconciled: input.capitalHistoryReconciled };
  const inputHash = hashJson(normalized);
  return inTransaction(db, () => {
    const scope = requireScope(db, scopeId);
    if (observedMs < scope.baseline_ms) {
      throw new DomainError("INVALID_INPUT", "equity observation precedes the baseline", [{ ruleId: "risk.observation_after_baseline", field: "observedAt" }]);
    }
    const duplicate = getRow<ObservationRow>(db, "SELECT id, input_hash, result_json, observed_ms FROM risk_equity_observations WHERE scope_id = ? AND source_ref = ?", scopeId, sourceRef);
    if (duplicate) {
      if (duplicate.input_hash !== inputHash) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "equity source reference was already observed with different content", [{ ruleId: "risk.observation_ref_once", field: "sourceRef" }]);
      }
      return JSON.parse(duplicate.result_json) as LossObservation;
    }
    const latest = getRow<ObservationRow>(db, "SELECT id, observed_ms, result_json, input_hash FROM risk_equity_observations WHERE scope_id = ? ORDER BY observed_ms DESC LIMIT 1", scopeId);
    if (latest && observedMs <= latest.observed_ms) {
      throw new DomainError("INVALID_INPUT", "equity observations must advance in time", [{ ruleId: "risk.observation_time_increases", field: "observedAt" }]);
    }

    const policy = parse(policySchema, JSON.parse(scope.policy_json) as unknown, "stored policy");
    validatePolicy(policy);
    const missing: LossObservation["missing"] = [];
    if (!input.accountReconciled) missing.push("account_reconciliation");
    if (!input.capitalHistoryReconciled) missing.push("capital_history_reconciliation");
    const dataReady = missing.length === 0;
    const capital = allRows<CapitalRow>(db, "SELECT id, input_hash, kind, amount_usdt FROM risk_capital_events WHERE scope_id = ? AND occurred_ms <= ?", scopeId, observedMs);
    const deposits = capital.filter((c) => c.kind === "deposit").reduce((sum, c) => sum.plus(decimal(c.amount_usdt, "stored capital amount")), new Decimal(0));
    const withdrawals = capital.filter((c) => c.kind === "withdrawal").reduce((sum, c) => sum.plus(decimal(c.amount_usdt, "stored capital amount")), new Decimal(0));
    const pnl = dataReady ? equity.plus(withdrawals).minus(deposits).minus(dec(policy.initialEquityUsdt)) : null;
    const loss = pnl ? Decimal.max(0, pnl.negated()) : null;
    const priorReady = getRow<ObservationRow>(db,
      "SELECT id, observed_ms, result_json, input_hash FROM risk_equity_observations WHERE scope_id = ? AND account_reconciled = 1 AND capital_history_reconciled = 1 ORDER BY observed_ms DESC LIMIT 1", scopeId);
    const priorLoss = priorReady ? (JSON.parse(priorReady.result_json) as LossObservation).cumulativeLossUsdt : null;
    const observationId = newId("equity");
    const newEvents: Array<{ id: string; kind: LossEventKind }> = [];
    if (loss) {
      for (const [kind, threshold] of [
        ["review", policy.lossLinesUsdt.review],
        ["soft_pause", policy.lossLinesUsdt.pause],
        ["hard_stop", policy.lossLinesUsdt.stop],
      ] as const) {
        if (loss.gte(dec(threshold)) && (priorLoss === null || dec(priorLoss).lt(dec(threshold)))) {
          newEvents.push({ id: newId("risk"), kind });
        }
      }
    }
    const previousEvents = allRows<LossEventRow>(db, "SELECT id, kind FROM risk_loss_events WHERE scope_id = ? ORDER BY rowid", scopeId);
    const events = [...previousEvents, ...newEvents];
    const state: LossState = events.some((e) => e.kind === "hard_stop") ? "hard_stopped"
      : events.some((e) => e.kind === "soft_pause") ? "soft_paused"
      : events.some((e) => e.kind === "review") ? "review_needed" : "active";
    const riskActions: LossObservation["requiredActions"] = state === "hard_stopped"
      ? ["cancel_risk_increasing_entries", "exit_managed_perpetuals", "review"]
      : state === "soft_paused" ? ["cancel_risk_increasing_entries", "review"]
      : state === "review_needed" ? ["review"] : [];
    const requiredActions: LossObservation["requiredActions"] = [
      ...(missing.includes("account_reconciliation") ? ["reconcile_account" as const] : []),
      ...(missing.includes("capital_history_reconciliation") ? ["reconcile_capital_history" as const] : []),
      ...riskActions,
    ];
    const result: LossObservation = {
      observationId, scopeId, policyHash: scope.policy_hash, observedAt, dataReady, missing,
      netPnlUsdt: pnl?.toFixed() ?? null,
      cumulativeLossUsdt: loss?.toFixed() ?? null,
      state,
      blockNewRisk: !dataReady || state === "soft_paused" || state === "hard_stopped",
      eventIds: events.map((e) => e.id), requiredActions,
    };
    db.prepare("INSERT INTO risk_loss_write_authorizations (id, scope_id, kind) VALUES (?, ?, 'observation')").run(observationId, scopeId);
    db.prepare("INSERT INTO risk_equity_observations (id, scope_id, source_ref, observed_at, observed_ms, equity_usdt, account_reconciled, capital_history_reconciled, input_hash, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(observationId, scopeId, sourceRef, observedAt, observedMs, equity.toFixed(), Number(input.accountReconciled), Number(input.capitalHistoryReconciled), inputHash, JSON.stringify(result));
    for (const event of newEvents) {
      db.prepare("INSERT INTO risk_loss_events (id, scope_id, observation_id, kind, loss_usdt, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(event.id, scopeId, observationId, event.kind, loss!.toFixed(), observedAt);
    }
    return result;
  });
}

function validatePolicy(policy: LossPolicy): void {
  const initial = decimal(policy.initialEquityUsdt, "policy.initialEquityUsdt");
  if (!initial.gt(0)) invalid("risk.initial_equity_positive", "policy.initialEquityUsdt");
  const budgets = Object.entries(policy.budgetsUsdt).map(([name, value]) => {
    const amount = decimal(value, `policy.budgetsUsdt.${name}`);
    if (amount.isNegative()) invalid("risk.budget_nonnegative", `policy.budgetsUsdt.${name}`);
    return amount;
  });
  if (budgets.reduce((sum, value) => sum.plus(value), new Decimal(0)).gt(initial)) invalid("risk.budgets_within_baseline", "policy.budgetsUsdt");
  const { review, pause, stop } = policy.lossLinesUsdt;
  const lines = [review, pause, stop].map((value) => decimal(value, "policy.lossLinesUsdt"));
  if (!lines[0]!.gt(0) || !lines[1]!.gt(lines[0]!) || !lines[2]!.gt(lines[1]!)) invalid("risk.loss_lines_ordered", "policy.lossLinesUsdt");
}

function requireScope(db: Db, scopeId: string): ScopeRow {
  const scope = getRow<ScopeRow>(db, "SELECT id, policy_hash, policy_json, baseline_ref, baseline_at, baseline_ms FROM risk_loss_scopes WHERE id = ?", scopeId);
  if (!scope) invalid("risk.scope_exists", "scopeId");
  requireCurrentArithmetic(db, scopeId);
  return scope;
}

function requireCurrentArithmetic(db: Db, scopeId: string): void {
  const marker = getRow<{ version: number }>(db, "SELECT version FROM risk_loss_scope_arithmetic WHERE scope_id = ?", scopeId);
  if (marker?.version !== 2) invalid("risk.legacy_arithmetic_requires_review", "scopeId");
}

function parse<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid("risk.schema", field);
  return result.data;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid("risk.required", field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  return parse(atTime, value, field);
}

function decimal(value: unknown, field: string): Decimal {
  if (typeof value !== "string" || !isDecimalString(value)) invalid("risk.decimal", field);
  return dec(value);
}

function invalid(ruleId: string, field: string): never {
  throw new DomainError("INVALID_INPUT", `invalid ${field}`, [{ ruleId, field }]);
}
