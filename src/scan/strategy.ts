import { readFileSync } from "node:fs";
import { z } from "zod";
import { DomainError } from "../lib/errors.ts";
import { hashJson } from "../lib/hash.ts";

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal string");

const screeningSchema = z
  .object({
    minTurnover24hUsdt: decimalString,
    maxSpreadBps: decimalString,
    minDepthUsdtPerSide: decimalString,
    minListingDays: z.number().int().min(0),
    maxDataAgeMs: z.number().int().positive(),
  })
  .strict();

export const strategySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    description: z.string(),
    // M0 has no validation pipeline, so "unvalidated" is the only representable state.
    validation: z.object({ state: z.literal("unvalidated") }).strict(),
    products: z
      .array(z.enum(["spot", "usdt_perpetual"]))
      .min(1)
      .refine((list) => new Set(list).size === list.length, "products must not repeat"),
    shortlistPerProduct: z.number().int().min(1).max(100),
    depthLevels: z.number().int().min(1).max(400),
    // null: no executability thresholds; scan output is a factual ranking only.
    screening: screeningSchema.nullable(),
  })
  .strict();

export type StrategyDefinition = z.infer<typeof strategySchema>;
export type Screening = z.infer<typeof screeningSchema>;

export interface LoadedStrategy {
  definition: StrategyDefinition;
  contentHash: string;
  path: string;
}

export function parseStrategy(json: unknown, path: string): LoadedStrategy {
  const result = strategySchema.safeParse(json);
  if (!result.success) {
    throw new DomainError(
      "INVALID_INPUT",
      `invalid strategy file ${path}`,
      result.error.issues.map((issue) => ({ ruleId: `strategy.${issue.code}`, field: issue.path.map(String).join(".") })),
    );
  }
  return { definition: result.data, contentHash: hashJson(result.data), path };
}

export function loadStrategy(path: string): LoadedStrategy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new DomainError("INVALID_INPUT", `cannot read strategy file ${path}`, [{ ruleId: "strategy.readable", field: "strategy" }]);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new DomainError("INVALID_INPUT", `strategy file ${path} is not valid JSON`, [{ ruleId: "strategy.json", field: "strategy" }]);
  }
  return parseStrategy(json, path);
}
