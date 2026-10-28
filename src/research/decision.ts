import type { ScanContent } from "../scan/scan.ts";
import type { AdversaryReport, AgentReport, StoredOutcome, SynthesisReport } from "./report-schema.ts";
import type { ResearchRole } from "./roles.ts";

/** Always present in M0: no draft card can be executed. */
export const READINESS_BLOCKERS = ["STRATEGY_NOT_VALIDATED", "M0_READ_ONLY"] as const;

export interface DraftCard {
  draftId: string;
  instId: string;
  product: "spot" | "usdt_perpetual";
  direction: "long" | "short";
  thesisHorizon: "short_term_catalyst" | "long_term_thesis";
  thesis: string;
  entryIdea: string;
  invalidation: string;
  evidenceRefs: string[];
  executable: false;
  /** Rules that disqualify this candidate. The synthesis cannot override them. */
  hardBlockers: string[];
  readinessBlockers: typeof READINESS_BLOCKERS;
  objections: Array<{ id: string; objection: string; blocking: boolean; response: string }>;
}

export interface Decision {
  synthesisDecision: "trade_candidate" | "wait" | "skip" | "unavailable";
  finalDecision: "trade_candidate" | "wait" | "skip";
  downgradeReason: string | null;
  waitConditions: string[];
  missingRoles: ResearchRole[];
  draftCards: DraftCard[];
  decidedAt: string;
}

export function decide(input: {
  runId: string;
  bundle: ScanContent;
  reports: Array<{ role: ResearchRole; outcome: StoredOutcome }>;
  decidedAt: string;
}): Decision {
  const { runId, bundle, reports, decidedAt } = input;
  const missingRoles = reports.filter((r) => r.outcome.kind === "failed").map((r) => r.role);
  // The role ties each report to its schema, so these casts follow from the role lookup.
  const synthesis = reportOf(reports, "synthesis") as SynthesisReport | null;
  if (!synthesis) {
    return { synthesisDecision: "unavailable", finalDecision: "wait", downgradeReason: "主控综合未完成，无法形成结论", waitConditions: [], missingRoles, draftCards: [], decidedAt };
  }
  if (synthesis.decision !== "trade_candidate") {
    return { synthesisDecision: synthesis.decision, finalDecision: synthesis.decision, downgradeReason: null, waitConditions: synthesis.waitConditions, missingRoles, draftCards: [], decidedAt };
  }

  const objections = (reportOf(reports, "adversary") as AdversaryReport | null)?.objections ?? [];
  const responses = new Map(synthesis.objectionResponses.map((r) => [r.objectionId, r.response]));
  const draftCards: DraftCard[] = synthesis.candidates.map((candidate, index) => {
    const relevant = objections.filter((o) => o.target === candidate.instId || o.target === "overall");
    return {
      draftId: `${runId}:card:${index + 1}`,
      instId: candidate.instId,
      product: candidate.product,
      direction: candidate.direction,
      thesisHorizon: candidate.thesisHorizon,
      thesis: candidate.thesis,
      entryIdea: candidate.entryIdea,
      invalidation: candidate.invalidation,
      evidenceRefs: candidate.evidenceRefs,
      executable: false,
      hardBlockers: [
        ...screeningBlockers(bundle, candidate.instId, candidate.product),
        ...missingRoles.map((role) => `ROLE_MISSING:${role}`),
        ...relevant.filter((o) => o.blocking).map((o) => `UNRESOLVED_OBJECTION:${o.id}`),
      ],
      readinessBlockers: READINESS_BLOCKERS,
      objections: relevant.map((o) => ({ id: o.id, objection: o.objection, blocking: o.blocking, response: responses.get(o.id) ?? "" })),
    };
  });

  if (draftCards.every((card) => card.hardBlockers.length > 0)) {
    const blockers = [...new Set(draftCards.flatMap((card) => card.hardBlockers))];
    return {
      synthesisDecision: "trade_candidate",
      finalDecision: "wait",
      downgradeReason: "所有候选均命中硬性阻断，主控结论不能覆盖",
      waitConditions: [...synthesis.waitConditions, ...blockers],
      missingRoles,
      draftCards,
      decidedAt,
    };
  }
  return { synthesisDecision: "trade_candidate", finalDecision: "trade_candidate", downgradeReason: null, waitConditions: synthesis.waitConditions, missingRoles, draftCards, decidedAt };
}

function reportOf(reports: Array<{ role: ResearchRole; outcome: StoredOutcome }>, role: ResearchRole): AgentReport | null {
  const found = reports.find((r) => r.role === role);
  return found && found.outcome.kind === "report" ? found.outcome.report : null;
}

function screeningBlockers(bundle: ScanContent, instId: string, product: string): string[] {
  const candidate = bundle.candidates.find((c) => c.instId === instId && c.product === product);
  if (bundle.screening === "not_configured" || !candidate || candidate.screening.state !== "applied") return ["SCREENING_NOT_CONFIGURED"];
  return candidate.screening.passed ? [] : ["SCREENING_FAILED"];
}
