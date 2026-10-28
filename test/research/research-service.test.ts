import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../../src/store/db.ts";
import { getEvidence } from "../../src/store/evidence-store.ts";
import { completeTask, getRun, nextTasks, startResearch, type ResearchTask } from "../../src/research/research-service.ts";
import type { ResearchRole } from "../../src/research/roles.ts";
import { NOW } from "../helpers/market-fixtures.ts";
import { expectDomainError } from "../helpers/assertions.ts";
import { adversaryReport, fundamentalsReport, marketStructureReport, quantReport, seedBundle, synthesisReport } from "../helpers/research-fixtures.ts";

const now = () => NOW;

async function setup() {
  const db = openDb(":memory:");
  const scan = await seedBundle(db);
  const ref = scan.candidates.find((c) => c.instId === "GOOD-USDT")?.snapshotEvidenceId ?? "";
  const run = startResearch(db, { bundleId: scan.bundleId, agentMode: "parallel_independent" }, now);
  return { db, scan, ref, run };
}

function taskFor(db: Db, runId: string, role: ResearchRole): ResearchTask {
  const task = nextTasks(db, runId).find((t) => t.role === role);
  assert.ok(task, `no open ${role} task`);
  return task;
}

function submit(db: Db, runId: string, role: ResearchRole, report: unknown) {
  return completeTask(db, { assignmentId: taskFor(db, runId, role).assignmentId, outcome: { kind: "report", report } }, now);
}

function completeIndependentPhase(db: Db, runId: string, ref: string) {
  submit(db, runId, "market_structure", marketStructureReport(ref));
  submit(db, runId, "fundamentals_events", fundamentalsReport(ref));
  return submit(db, runId, "quant_validation", quantReport(ref));
}

test("A03: a run opens three independent tasks bound to one bundle version, each blind to the others", async () => {
  const { db, run } = await setup();
  assert.equal(run.status, "independent_research");
  assert.equal(run.agentMode, "parallel_independent");
  assert.equal(run.hostVerified, false);
  const tasks = nextTasks(db, run.runId);
  assert.deepEqual(tasks.map((t) => t.role), ["market_structure", "fundamentals_events", "quant_validation"]);
  for (const task of tasks) {
    assert.deepEqual(task.priorReports, []);
    assert.deepEqual(task.bundle, { id: run.bundleId, sha256: run.bundleSha256 });
    assert.ok(task.brief.length > 0 && task.rules.length > 0);
  }
});

test("A03: the adversary opens only after every independent role finishes, and then sees their reports", async () => {
  const { db, run, ref } = await setup();
  submit(db, run.runId, "market_structure", marketStructureReport(ref));
  submit(db, run.runId, "fundamentals_events", fundamentalsReport(ref));
  assert.deepEqual(nextTasks(db, run.runId).map((t) => t.role), ["quant_validation"]);
  const view = submit(db, run.runId, "quant_validation", quantReport(ref));
  assert.equal(view.status, "challenge");
  const tasks = nextTasks(db, run.runId);
  assert.deepEqual(tasks.map((t) => t.role), ["adversary"]);
  assert.deepEqual(tasks[0]?.priorReports.map((p) => p.role), ["market_structure", "fundamentals_events", "quant_validation"]);
});

test("synthesis opens only after the adversary, and sees all four earlier reports", async () => {
  const { db, run, ref } = await setup();
  completeIndependentPhase(db, run.runId, ref);
  const view = submit(db, run.runId, "adversary", adversaryReport(ref));
  assert.equal(view.status, "synthesis");
  const [task] = nextTasks(db, run.runId);
  assert.equal(task?.role, "synthesis");
  assert.deepEqual(task?.priorReports.map((p) => p.role), ["market_structure", "fundamentals_events", "quant_validation", "adversary"]);
});

test("a role that cannot run is recorded as missing and does not stall the run", async () => {
  const { db, run, ref } = await setup();
  completeTask(db, { assignmentId: taskFor(db, run.runId, "market_structure").assignmentId, outcome: { kind: "failed", reason: "宿主没有可用的子 Agent" } }, now);
  submit(db, run.runId, "fundamentals_events", fundamentalsReport(ref));
  const view = submit(db, run.runId, "quant_validation", quantReport(ref));
  assert.deepEqual(view.missingRoles, ["market_structure"]);
  assert.equal(view.status, "challenge");
  expectDomainError(
    () => completeTask(db, { assignmentId: taskFor(db, run.runId, "adversary").assignmentId, outcome: { kind: "failed", reason: "  " } }, now),
    "INVALID_INPUT",
    { ruleId: "research.failure_reason" },
  );
});

test("reports citing evidence outside the bundle are rejected and the task stays open", async () => {
  const { db, run } = await setup();
  expectDomainError(() => submit(db, run.runId, "market_structure", marketStructureReport("ev_not_in_bundle")), "INVALID_INPUT", {
    ruleId: "research.evidence_ref_known",
  });
  assert.ok(nextTasks(db, run.runId).some((t) => t.role === "market_structure"));
});

test("A17: the quant role cannot claim a historical validation in M0", async () => {
  const { db, run, ref } = await setup();
  expectDomainError(() => submit(db, run.runId, "quant_validation", { ...quantReport(ref), historicalValidation: "performed" }), "INVALID_INPUT", {
    field: "historicalValidation",
  });
});

test("source URLs must be http or https", async () => {
  const { db, run, ref } = await setup();
  const report = fundamentalsReport(ref);
  report.sources[0] = { ...report.sources[0]!, url: "javascript:alert(1)" };
  expectDomainError(() => submit(db, run.runId, "fundamentals_events", report), "INVALID_INPUT", { field: "sources.0.url" });
});

test("external sources become evidence items that later roles may cite", async () => {
  const { db, run, ref } = await setup();
  const view = completeIndependentPhase(db, run.runId, ref);
  const fundamentals = view.reports.find((r) => r.role === "fundamentals_events");
  assert.ok(fundamentals?.outcome.kind === "report");
  const evidenceId = fundamentals.outcome.sourceEvidenceIds.src1;
  assert.ok(evidenceId);
  const item = getEvidence(db, evidenceId);
  assert.equal(item?.kind, "external_source");
  assert.equal(item?.source, "https://example.com/good-mainnet-upgrade");
  assert.equal(item?.publishedAt, "2026-10-27T08:00:00Z");
  assert.equal(item?.submittedBy, `research:${run.runId}:fundamentals_events`);
  const after = submit(db, run.runId, "adversary", { ...adversaryReport(ref), claims: [{ statement: "公告未给出时间表细节", label: "inference", evidenceRefs: [evidenceId] }] });
  assert.equal(after.status, "synthesis");
});

test("resubmitting the identical outcome is idempotent; different content conflicts", async () => {
  const { db, run, ref } = await setup();
  const assignmentId = taskFor(db, run.runId, "market_structure").assignmentId;
  const first = completeTask(db, { assignmentId, outcome: { kind: "report", report: marketStructureReport(ref) } }, now);
  const replay = completeTask(db, { assignmentId, outcome: { kind: "report", report: marketStructureReport(ref) } }, now);
  assert.deepEqual(replay, first);
  expectDomainError(
    () => completeTask(db, { assignmentId, outcome: { kind: "report", report: { ...marketStructureReport(ref), summary: "改过的结论" } } }, now),
    "IDEMPOTENCY_CONFLICT",
  );
});

test("synthesis must answer every objection and may only pick bundle candidates", async () => {
  const { db, run, ref } = await setup();
  completeIndependentPhase(db, run.runId, ref);
  submit(db, run.runId, "adversary", adversaryReport(ref));
  expectDomainError(() => submit(db, run.runId, "synthesis", synthesisReport(ref, { objectionIds: [] })), "INVALID_INPUT", { ruleId: "research.objection_answered" });
  expectDomainError(() => submit(db, run.runId, "synthesis", synthesisReport(ref, { objectionIds: ["obj1", "obj9"] })), "INVALID_INPUT", { ruleId: "research.objection_known" });
  expectDomainError(
    () => submit(db, run.runId, "synthesis", synthesisReport(ref, { candidates: [{ instId: "MOON-USDT", product: "spot", direction: "long" }] })),
    "INVALID_INPUT",
    { ruleId: "research.candidate_in_bundle" },
  );
  expectDomainError(
    () => submit(db, run.runId, "synthesis", synthesisReport(ref, { candidates: [{ instId: "GOOD-USDT", product: "spot", direction: "short" }] })),
    "INVALID_INPUT",
    { field: "candidates.0.direction" },
  );
});

test("unknown bundles, runs, assignments and agent modes are INVALID_INPUT", async () => {
  const { db, scan } = await setup();
  expectDomainError(() => startResearch(db, { bundleId: "bundle_missing", agentMode: "serial_degraded" }, now), "INVALID_INPUT", { ruleId: "research.bundle_exists" });
  expectDomainError(() => startResearch(db, { bundleId: scan.bundleId, agentMode: "swarm" as never }, now), "INVALID_INPUT", { ruleId: "research.agent_mode" });
  expectDomainError(() => nextTasks(db, "run_missing"), "INVALID_INPUT", { ruleId: "research.run_exists" });
  expectDomainError(() => getRun(db, "run_missing"), "INVALID_INPUT", { ruleId: "research.run_exists" });
  expectDomainError(
    () => completeTask(db, { assignmentId: "asg_missing", outcome: { kind: "failed", reason: "x" } }, now),
    "INVALID_INPUT",
    { ruleId: "research.assignment_exists" },
  );
});
