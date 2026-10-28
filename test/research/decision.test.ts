import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../../src/research/decision.ts";
import { parseReport, type StoredOutcome } from "../../src/research/report-schema.ts";
import type { ResearchRole } from "../../src/research/roles.ts";
import type { ScanCandidate, ScanContent } from "../../src/scan/scan.ts";
import { adversaryReport, fundamentalsReport, marketStructureReport, quantReport, synthesisReport } from "../helpers/research-fixtures.ts";

const REF = "ev_good";
const DECIDED_AT = "2026-10-28T12:30:00.000Z";

function candidate(instId: string, product: "spot" | "usdt_perpetual", screening: ScanCandidate["screening"]): ScanCandidate {
  return { instId, product, snapshotEvidenceId: REF, turnover24hUsdt: "10000000", change24hPct: "11.1111", spreadBps: "2", screening };
}

function bundle(screening: "applied" | "not_configured", candidates?: ScanCandidate[]): ScanContent {
  const defaultScreening: ScanCandidate["screening"] = screening === "applied" ? { state: "applied", passed: true, checks: [] } : { state: "not_configured" };
  return {
    createdAt: "2026-10-28T12:00:00.000Z",
    site: "global",
    strategy: { id: "test-flow", version: 1, contentHash: "h", validation: "unvalidated" },
    screening,
    products: [],
    sourceErrors: [],
    candidates: candidates ?? [candidate("GOOD-USDT", "spot", defaultScreening)],
  };
}

function reports(opts: {
  synthesis: unknown;
  adversary?: unknown;
  failed?: ResearchRole[];
  synthesisSourceEvidenceIds?: Record<string, string>;
}): Array<{ role: ResearchRole; outcome: StoredOutcome }> {
  const raw: Record<ResearchRole, unknown> = {
    market_structure: marketStructureReport(REF),
    fundamentals_events: fundamentalsReport(REF),
    quant_validation: quantReport(REF),
    adversary: opts.adversary ?? adversaryReport(REF),
    synthesis: opts.synthesis,
  };
  return (Object.keys(raw) as ResearchRole[]).map((role) => ({
    role,
    outcome: opts.failed?.includes(role)
      ? { kind: "failed", reason: "宿主未运行该角色" }
      : { kind: "report", report: parseReport(role, raw[role]), sourceEvidenceIds: (role === "synthesis" ? opts.synthesisSourceEvidenceIds : undefined) ?? {} },
  }));
}

test("wait and skip pass through with no draft cards", () => {
  for (const decision of ["wait", "skip"] as const) {
    const result = decide({ runId: "run_1", bundle: bundle("applied"), reports: reports({ synthesis: synthesisReport(REF, { decision }) }), decidedAt: DECIDED_AT });
    assert.equal(result.finalDecision, decision);
    assert.equal(result.synthesisDecision, decision);
    assert.deepEqual(result.draftCards, []);
    assert.equal(result.downgradeReason, null);
  }
});

test("a clean candidate yields a trade_candidate whose draft card is still not executable", () => {
  const result = decide({ runId: "run_1", bundle: bundle("applied"), reports: reports({ synthesis: synthesisReport(REF) }), decidedAt: DECIDED_AT });
  assert.equal(result.finalDecision, "trade_candidate");
  assert.equal(result.decidedAt, DECIDED_AT);
  const [card] = result.draftCards;
  assert.ok(card);
  assert.equal(card.draftId, "run_1:card:1");
  assert.equal(card.executable, false);
  assert.deepEqual(card.hardBlockers, []);
  assert.deepEqual(card.readinessBlockers, ["STRATEGY_NOT_VALIDATED", "M0_READ_ONLY"]);
  assert.deepEqual(card.objections, [{ id: "obj1", objection: "涨幅可能来自少数大单，事件落地后回吐", blocking: false, response: "已纳入失效条件，回落即放弃" }]);
});

test("A02: a candidate that failed screening downgrades the decision to wait", () => {
  const failed = bundle("applied", [candidate("GOOD-USDT", "spot", { state: "applied", passed: false, checks: [] })]);
  const result = decide({ runId: "run_1", bundle: failed, reports: reports({ synthesis: synthesisReport(REF) }), decidedAt: DECIDED_AT });
  assert.equal(result.synthesisDecision, "trade_candidate");
  assert.equal(result.finalDecision, "wait");
  assert.ok(result.downgradeReason);
  assert.deepEqual(result.draftCards[0]?.hardBlockers, ["SCREENING_FAILED"]);
  assert.ok(result.waitConditions.includes("SCREENING_FAILED"));
});

test("an unscreened bundle cannot produce a trade candidate", () => {
  const result = decide({ runId: "run_1", bundle: bundle("not_configured"), reports: reports({ synthesis: synthesisReport(REF) }), decidedAt: DECIDED_AT });
  assert.equal(result.finalDecision, "wait");
  assert.deepEqual(result.draftCards[0]?.hardBlockers, ["SCREENING_NOT_CONFIGURED"]);
});

test("a blocking objection cannot be overridden by the synthesis, even when answered", () => {
  const result = decide({
    runId: "run_1",
    bundle: bundle("applied"),
    reports: reports({ synthesis: synthesisReport(REF), adversary: adversaryReport(REF, { blocking: true, target: "overall" }) }),
    decidedAt: DECIDED_AT,
  });
  assert.equal(result.finalDecision, "wait");
  assert.deepEqual(result.draftCards[0]?.hardBlockers, ["UNRESOLVED_OBJECTION:obj1"]);
});

test("a blocking objection about another instrument does not block this candidate", () => {
  const result = decide({
    runId: "run_1",
    bundle: bundle("applied"),
    reports: reports({ synthesis: synthesisReport(REF), adversary: adversaryReport(REF, { blocking: true, target: "WIDE-USDT" }) }),
    decidedAt: DECIDED_AT,
  });
  assert.equal(result.finalDecision, "trade_candidate");
  assert.deepEqual(result.draftCards[0]?.objections, []);
});

test("a missing independent role is a hard blocker and is listed", () => {
  const result = decide({ runId: "run_1", bundle: bundle("applied"), reports: reports({ synthesis: synthesisReport(REF), failed: ["fundamentals_events"] }), decidedAt: DECIDED_AT });
  assert.deepEqual(result.missingRoles, ["fundamentals_events"]);
  assert.equal(result.finalDecision, "wait");
  assert.deepEqual(result.draftCards[0]?.hardBlockers, ["ROLE_MISSING:fundamentals_events"]);
});

test("with one clean and one blocked candidate the decision stays trade_candidate and shows both cards", () => {
  const mixed = bundle("applied", [
    candidate("GOOD-USDT", "spot", { state: "applied", passed: true, checks: [] }),
    candidate("WIDE-USDT", "spot", { state: "applied", passed: false, checks: [] }),
  ]);
  const synthesis = synthesisReport(REF, {
    candidates: [
      { instId: "GOOD-USDT", product: "spot", direction: "long" },
      { instId: "WIDE-USDT", product: "spot", direction: "long" },
    ],
  });
  const result = decide({ runId: "run_1", bundle: mixed, reports: reports({ synthesis }), decidedAt: DECIDED_AT });
  assert.equal(result.finalDecision, "trade_candidate");
  assert.deepEqual(result.draftCards.map((c) => c.hardBlockers), [[], ["SCREENING_FAILED"]]);
  assert.ok(result.draftCards.every((c) => c.executable === false));
});

test("a failed synthesis means no conclusion: wait, no cards", () => {
  const result = decide({ runId: "run_1", bundle: bundle("applied"), reports: reports({ synthesis: synthesisReport(REF), failed: ["synthesis"] }), decidedAt: DECIDED_AT });
  assert.equal(result.synthesisDecision, "unavailable");
  assert.equal(result.finalDecision, "wait");
  assert.deepEqual(result.draftCards, []);
});

test("a blocking objection targeting the candidate's own instId blocks it", () => {
  const result = decide({
    runId: "run_1",
    bundle: bundle("applied"),
    reports: reports({ synthesis: synthesisReport(REF), adversary: adversaryReport(REF, { blocking: true, target: "GOOD-USDT" }) }),
    decidedAt: DECIDED_AT,
  });
  assert.equal(result.finalDecision, "wait");
  assert.deepEqual(result.draftCards[0]?.hardBlockers, ["UNRESOLVED_OBJECTION:obj1"]);
});

test("a failed adversary is a hard blocker", () => {
  const result = decide({ runId: "run_1", bundle: bundle("applied"), reports: reports({ synthesis: synthesisReport(REF), failed: ["adversary"] }), decidedAt: DECIDED_AT });
  assert.equal(result.finalDecision, "wait");
  assert.deepEqual(result.draftCards[0]?.hardBlockers, ["ROLE_MISSING:adversary"]);
});

test("draft card evidence refs resolve the synthesis's own source keys to evidence ids", () => {
  const synthesis = {
    ...synthesisReport("src1"),
    sources: [{ key: "src1", url: "https://example.com/x", publishedAt: null, fetchedAt: "2026-10-28T11:00:00Z", label: "fact", instIds: ["GOOD-USDT"], excerpt: "e" }],
  };
  const result = decide({
    runId: "run_1",
    bundle: bundle("applied"),
    reports: reports({ synthesis, synthesisSourceEvidenceIds: { src1: "ev_resolved" } }),
    decidedAt: DECIDED_AT,
  });
  const refs = result.draftCards[0]?.evidenceRefs ?? [];
  assert.ok(refs.includes("ev_resolved"));
  assert.ok(!refs.includes("src1"));
});
