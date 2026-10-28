import { DomainError } from "../lib/errors.ts";
import { hashJson } from "../lib/hash.ts";
import { newId } from "../lib/ids.ts";
import { allRows, getRow, inTransaction, type Db } from "../store/db.ts";
import { getBundle, saveEvidence } from "../store/evidence-store.ts";
import { appendAudit } from "../store/audit.ts";
import type { ScanContent } from "../scan/scan.ts";
import { COMMON_RULES_ZH, ROLE_BRIEF_ZH, ROLES_BY_PHASE, type ResearchPhase, type ResearchRole } from "./roles.ts";
import { collectEvidenceRefs, parseReport, type AdversaryReport, type AgentReport, type StoredOutcome, type SynthesisReport } from "./report-schema.ts";

export type AgentMode = "parallel_independent" | "serial_degraded";
export const AGENT_MODES: readonly AgentMode[] = ["parallel_independent", "serial_degraded"];

export type SubmittedOutcome = { kind: "report"; report: unknown } | { kind: "failed"; reason: string };

export interface AssignmentView {
  assignmentId: string;
  role: ResearchRole;
  phase: ResearchPhase;
  state: "open" | "completed" | "failed";
  completedAt: string | null;
}

export interface PriorReport {
  role: ResearchRole;
  phase: ResearchPhase;
  outcome: StoredOutcome;
}

export interface ResearchTask {
  assignmentId: string;
  runId: string;
  role: ResearchRole;
  phase: ResearchPhase;
  brief: string;
  rules: string;
  bundle: { id: string; sha256: string };
  /** Empty in phase 1: independent roles never see each other's reports. */
  priorReports: PriorReport[];
}

export type RunStatus = "independent_research" | "challenge" | "synthesis" | "decided";

export interface ResearchRunView {
  runId: string;
  bundleId: string;
  bundleSha256: string;
  createdAt: string;
  agentMode: AgentMode;
  /** M0 cannot verify how the host ran its agents; the declared mode is recorded as unverified. */
  hostVerified: false;
  status: RunStatus;
  assignments: AssignmentView[];
  reports: PriorReport[];
  missingRoles: ResearchRole[];
  decision: null;
}

interface RunRow {
  id: string;
  bundle_id: string;
  bundle_sha256: string;
  agent_mode: AgentMode;
  created_at: string;
  decision: string | null;
}

interface AssignmentRow {
  id: string;
  run_id: string;
  role: ResearchRole;
  phase: ResearchPhase;
  state: "open" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
  outcome: string | null;
  submitted_sha256: string | null;
}

export function startResearch(db: Db, input: { bundleId: string; agentMode: AgentMode }, now: () => Date): ResearchRunView {
  if (!AGENT_MODES.includes(input.agentMode)) {
    throw new DomainError("INVALID_INPUT", `agentMode must be one of ${AGENT_MODES.join(", ")}`, [{ ruleId: "research.agent_mode", field: "agentMode" }]);
  }
  const bundle = getBundle(db, input.bundleId);
  if (!bundle) {
    throw new DomainError("INVALID_INPUT", `unknown evidence bundle ${input.bundleId}`, [{ ruleId: "research.bundle_exists", field: "bundleId" }]);
  }
  const runId = newId("run");
  const at = now().toISOString();
  inTransaction(db, () => {
    db.prepare("INSERT INTO research_runs (id, bundle_id, bundle_sha256, agent_mode, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, bundle.id, bundle.contentSha256, input.agentMode, at);
    createAssignments(db, runId, 1, at);
    appendAudit(db, at, "research.started", runId, { bundleId: bundle.id, agentMode: input.agentMode });
  });
  return getRun(db, runId);
}

export function nextTasks(db: Db, runId: string): ResearchTask[] {
  const run = requireRun(db, runId);
  const assignments = loadAssignments(db, runId);
  return assignments
    .filter((a) => a.state === "open")
    .map((a) => ({
      assignmentId: a.id,
      runId,
      role: a.role,
      phase: a.phase,
      brief: ROLE_BRIEF_ZH[a.role],
      rules: COMMON_RULES_ZH,
      bundle: { id: run.bundle_id, sha256: run.bundle_sha256 },
      priorReports: toReports(assignments.filter((p) => p.phase < a.phase)),
    }));
}

export function completeTask(db: Db, input: { assignmentId: string; outcome: SubmittedOutcome }, now: () => Date): ResearchRunView {
  const at = now().toISOString();
  const runId = inTransaction(db, () => {
    const assignment = getRow<AssignmentRow>(db, "SELECT * FROM research_assignments WHERE id = ?", input.assignmentId);
    if (!assignment) {
      throw new DomainError("INVALID_INPUT", `unknown assignment ${input.assignmentId}`, [{ ruleId: "research.assignment_exists", field: "assignmentId" }]);
    }
    const submittedSha256 = hashJson(input.outcome);
    if (assignment.state !== "open") {
      if (assignment.submitted_sha256 === submittedSha256) return assignment.run_id; // identical replay
      throw new DomainError("IDEMPOTENCY_CONFLICT", `assignment ${assignment.id} was already finished with different content`, [
        { ruleId: "research.assignment_once", field: "assignmentId" },
      ]);
    }
    const run = requireRun(db, assignment.run_id);
    const stored = toStoredOutcome(db, run, assignment, input.outcome);
    db.prepare("UPDATE research_assignments SET state = ?, completed_at = ?, outcome = ?, submitted_sha256 = ? WHERE id = ?").run(
      stored.kind === "report" ? "completed" : "failed",
      at,
      JSON.stringify(stored),
      submittedSha256,
      assignment.id,
    );
    appendAudit(db, at, "research.task_finished", assignment.id, { runId: run.id, role: assignment.role, outcome: stored.kind });
    advancePhase(db, run, at);
    return run.id;
  });
  return getRun(db, runId);
}

export function getRun(db: Db, runId: string): ResearchRunView {
  const run = requireRun(db, runId);
  const assignments = loadAssignments(db, runId);
  return {
    runId: run.id,
    bundleId: run.bundle_id,
    bundleSha256: run.bundle_sha256,
    createdAt: run.created_at,
    agentMode: run.agent_mode,
    hostVerified: false,
    status: runStatus(assignments),
    assignments: assignments.map((a) => ({ assignmentId: a.id, role: a.role, phase: a.phase, state: a.state, completedAt: a.completed_at })),
    reports: toReports(assignments),
    missingRoles: assignments.filter((a) => a.state === "failed").map((a) => a.role),
    decision: null,
  };
}

function toStoredOutcome(db: Db, run: RunRow, assignment: AssignmentRow, outcome: SubmittedOutcome): StoredOutcome {
  if (outcome.kind === "failed") {
    if (typeof outcome.reason !== "string" || outcome.reason.trim() === "") {
      throw new DomainError("INVALID_INPUT", "a failed outcome needs a non-empty reason", [{ ruleId: "research.failure_reason", field: "reason" }]);
    }
    return { kind: "failed", reason: outcome.reason };
  }
  const report = parseReport(assignment.role, outcome.report);
  const bundle = bundleContent(db, run);
  const prior = toReports(loadAssignments(db, run.id).filter((a) => a.phase < assignment.phase));
  checkEvidenceRefs(report, bundle, prior);
  if (assignment.role === "synthesis") checkSynthesis(report as SynthesisReport, bundle, prior);

  const sourceEvidenceIds: Record<string, string> = {};
  for (const source of report.sources) {
    const item = saveEvidence(db, {
      kind: "external_source",
      source: source.url,
      publishedAt: source.publishedAt,
      collectedAt: source.fetchedAt,
      label: source.label,
      instIds: source.instIds,
      content: { excerpt: source.excerpt },
      rawRef: null,
      submittedBy: `research:${run.id}:${assignment.role}`,
    });
    sourceEvidenceIds[source.key] = item.id;
  }
  return { kind: "report", report, sourceEvidenceIds };
}

function checkEvidenceRefs(report: AgentReport, bundle: ScanContent, prior: PriorReport[]): void {
  const keys = report.sources.map((s) => s.key);
  const duplicate = keys.find((key, i) => keys.indexOf(key) !== i);
  if (duplicate) {
    throw new DomainError("INVALID_INPUT", `duplicate source key ${duplicate}`, [{ ruleId: "research.source_key_unique", field: "sources" }]);
  }
  const allowed = new Set<string>([...bundle.candidates.map((c) => c.snapshotEvidenceId), ...keys]);
  for (const p of prior) {
    if (p.outcome.kind === "report") for (const id of Object.values(p.outcome.sourceEvidenceIds)) allowed.add(id);
  }
  const unknown = [...new Set(collectEvidenceRefs(report).filter((ref) => !allowed.has(ref)))];
  if (unknown.length > 0) {
    throw new DomainError(
      "INVALID_INPUT",
      `unknown evidence references: ${unknown.join(", ")}`,
      unknown.map((ref) => ({ ruleId: "research.evidence_ref_known", evidenceRef: ref })),
    );
  }
}

function checkSynthesis(report: SynthesisReport, bundle: ScanContent, prior: PriorReport[]): void {
  report.candidates.forEach((candidate, i) => {
    if (!bundle.candidates.some((b) => b.instId === candidate.instId && b.product === candidate.product)) {
      throw new DomainError("INVALID_INPUT", `candidate ${candidate.instId} (${candidate.product}) is not in the evidence bundle`, [
        { ruleId: "research.candidate_in_bundle", field: `candidates.${i}` },
      ]);
    }
  });
  const adversary = prior.find((p) => p.role === "adversary");
  const objectionIds = adversary?.outcome.kind === "report" ? (adversary.outcome.report as AdversaryReport).objections.map((o) => o.id) : [];
  const answered = new Set(report.objectionResponses.map((r) => r.objectionId));
  const unanswered = objectionIds.filter((id) => !answered.has(id));
  if (unanswered.length > 0) {
    throw new DomainError("INVALID_INPUT", `synthesis must respond to every objection; missing: ${unanswered.join(", ")}`, [
      { ruleId: "research.objection_answered", field: "objectionResponses" },
    ]);
  }
  const unknown = [...answered].filter((id) => !objectionIds.includes(id));
  if (unknown.length > 0) {
    throw new DomainError("INVALID_INPUT", `responses reference unknown objections: ${unknown.join(", ")}`, [
      { ruleId: "research.objection_known", field: "objectionResponses" },
    ]);
  }
}

function advancePhase(db: Db, run: RunRow, at: string): void {
  const assignments = loadAssignments(db, run.id);
  const current = currentPhase(assignments);
  if (assignments.some((a) => a.phase === current && a.state === "open")) return;
  if (current < 3) createAssignments(db, run.id, (current + 1) as ResearchPhase, at);
}

function createAssignments(db: Db, runId: string, phase: ResearchPhase, at: string): void {
  for (const role of ROLES_BY_PHASE[phase]) {
    db.prepare("INSERT INTO research_assignments (id, run_id, role, phase, state, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
      .run(newId("asg"), runId, role, phase, at);
  }
}

function runStatus(assignments: AssignmentRow[]): RunStatus {
  const current = currentPhase(assignments);
  const open = assignments.some((a) => a.phase === current && a.state === "open");
  if (current === 3) return open ? "synthesis" : "decided";
  return current === 1 ? "independent_research" : "challenge";
}

function currentPhase(assignments: AssignmentRow[]): ResearchPhase {
  return Math.max(...assignments.map((a) => a.phase)) as ResearchPhase;
}

function toReports(assignments: AssignmentRow[]): PriorReport[] {
  return assignments.filter((a) => a.state !== "open").map((a) => ({ role: a.role, phase: a.phase, outcome: parseOutcome(a) }));
}

function parseOutcome(assignment: AssignmentRow): StoredOutcome {
  if (assignment.outcome === null) throw new Error(`assignment ${assignment.id} is finished but has no stored outcome`);
  return JSON.parse(assignment.outcome) as StoredOutcome;
}

function bundleContent(db: Db, run: RunRow): ScanContent {
  const bundle = getBundle(db, run.bundle_id);
  if (!bundle) throw new Error(`run ${run.id} references missing bundle ${run.bundle_id}`);
  return bundle.content as ScanContent;
}

function requireRun(db: Db, runId: string): RunRow {
  const run = getRow<RunRow>(db, "SELECT * FROM research_runs WHERE id = ?", runId);
  if (!run) throw new DomainError("INVALID_INPUT", `unknown research run ${runId}`, [{ ruleId: "research.run_exists", field: "runId" }]);
  return run;
}

function loadAssignments(db: Db, runId: string): AssignmentRow[] {
  return allRows<AssignmentRow>(db, "SELECT * FROM research_assignments WHERE run_id = ? ORDER BY phase, rowid", runId);
}
