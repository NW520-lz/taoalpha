import { z } from "zod";
import { DomainError } from "../lib/errors.ts";
import type { ResearchRole } from "./roles.ts";

const isoTime = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1);
const refs = z.array(text);
const label = z.enum(["fact", "inference"]);

const claim = z.object({ statement: text, label, evidenceRefs: refs }).strict();

const source = z
  .object({
    key: z.string().regex(/^src[0-9]+$/, "source keys look like src1, src2"),
    url: z.url({ protocol: /^https?$/ }),
    publishedAt: isoTime.nullable(),
    fetchedAt: isoTime,
    label,
    instIds: z.array(text),
    excerpt: z.string().max(2000),
  })
  .strict();

const common = {
  summary: text,
  claims: z.array(claim),
  sources: z.array(source),
  unknowns: z.array(text),
  missingData: z.array(text),
};

const marketStructure = z
  .object({
    ...common,
    assessments: z.array(
      z
        .object({
          instId: text,
          regime: z.enum(["trend_up", "trend_down", "range", "unclear"]),
          scenarios: z.array(text),
          entryIdea: text.nullable(),
          invalidation: text.nullable(),
          evidenceRefs: refs.min(1),
        })
        .strict(),
    ),
  })
  .strict();

const fundamentalsEvents = z
  .object({
    ...common,
    events: z.array(
      z
        .object({
          instId: text,
          event: text,
          eventTime: isoTime.nullable(),
          impactPath: text,
          counterExplanation: text,
          verified: z.boolean(),
          evidenceRefs: refs,
        })
        .strict(),
    ),
  })
  .strict();

const quantValidation = z
  .object({
    ...common,
    // M0 has no backtest engine; any other value would be a fabricated validation.
    historicalValidation: z.literal("not_performed"),
    computations: z.array(z.object({ description: text, method: text, result: text, evidenceRefs: refs.min(1) }).strict()),
  })
  .strict();

const adversary = z
  .object({
    ...common,
    objections: z.array(
      z
        .object({
          id: z.string().regex(/^obj[0-9]+$/, "objection ids look like obj1, obj2"),
          target: text, // an instId or "overall"
          objection: text,
          strongestCounterEvidence: text,
          waitCondition: text.nullable(),
          blocking: z.boolean(),
          evidenceRefs: refs,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((report, ctx) => {
    const ids = report.objections.map((o) => o.id);
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i) ctx.addIssue({ code: "custom", path: ["objections", i, "id"], message: `duplicate objection id ${id}` });
    });
  });

const synthesis = z
  .object({
    ...common,
    decision: z.enum(["trade_candidate", "wait", "skip"]),
    candidates: z.array(
      z
        .object({
          instId: text,
          product: z.enum(["spot", "usdt_perpetual"]),
          direction: z.enum(["long", "short"]),
          thesisHorizon: z.enum(["short_term_catalyst", "long_term_thesis"]),
          thesis: text,
          entryIdea: text,
          invalidation: text,
          evidenceRefs: refs.min(1),
        })
        .strict(),
    ),
    waitConditions: z.array(text),
    objectionResponses: z.array(z.object({ objectionId: text, response: text }).strict()),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.decision === "trade_candidate" && report.candidates.length === 0) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "trade_candidate requires at least one candidate" });
    }
    if (report.decision !== "trade_candidate" && report.candidates.length > 0) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "only trade_candidate may list candidates" });
    }
    report.candidates.forEach((candidate, i) => {
      if (report.candidates.findIndex((c) => c.instId === candidate.instId && c.product === candidate.product) !== i) {
        ctx.addIssue({ code: "custom", path: ["candidates", i], message: "duplicate candidate" });
      }
      if (candidate.product === "spot" && candidate.direction === "short") {
        ctx.addIssue({ code: "custom", path: ["candidates", i, "direction"], message: "spot candidates cannot be short" });
      }
    });
  });

export const REPORT_SCHEMAS = {
  market_structure: marketStructure,
  fundamentals_events: fundamentalsEvents,
  quant_validation: quantValidation,
  adversary,
  synthesis,
} satisfies Record<ResearchRole, z.ZodType>;

export type AdversaryReport = z.infer<typeof adversary>;
export type SynthesisReport = z.infer<typeof synthesis>;
export type AgentReport = z.infer<(typeof REPORT_SCHEMAS)[ResearchRole]>;

/** What is persisted for a finished assignment. sourceEvidenceIds maps report source keys to saved evidence IDs. */
export type StoredOutcome =
  | { kind: "report"; report: AgentReport; sourceEvidenceIds: Record<string, string> }
  | { kind: "failed"; reason: string };

export function parseReport(role: ResearchRole, input: unknown): AgentReport {
  const result = REPORT_SCHEMAS[role].safeParse(input);
  if (!result.success) {
    throw new DomainError(
      "INVALID_INPUT",
      `report does not match the ${role} schema: ${result.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")}`,
      result.error.issues.map((issue) => ({ ruleId: `schema.${issue.code}`, field: issue.path.map(String).join(".") })),
    );
  }
  return result.data;
}

/** Every string inside any "evidenceRefs" array, at any depth. */
export function collectEvidenceRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectEvidenceRefs);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "evidenceRefs" && Array.isArray(child)
      ? child.filter((ref): ref is string => typeof ref === "string")
      : collectEvidenceRefs(child),
  );
}
