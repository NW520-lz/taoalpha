import { z } from "zod";
import { Decimal, dec, isDecimalString } from "./risk-decimal.ts";
import { DomainError, type Violation } from "../lib/errors.ts";

const text = z.string().trim().min(1);
const instant = z.iso.datetime({ offset: true });
const nonnegative = z.string().refine((value) => isDecimalString(value) && dec(value).gte(0), "must be a nonnegative decimal string");
const positive = z.string().refine((value) => isDecimalString(value) && dec(value).gt(0), "must be a positive decimal string");
const product = z.enum(["spot", "usdt_perpetual"]);
const direction = z.enum(["long", "short"]);

const costs = z.object({
  /** Full entry/exit estimates. Expected funding income cannot reduce planned risk. */
  feesUsdt: nonnegative,
  /** Residual loss beyond the input prices; do not repeat slippage already embedded in those prices. */
  slippageUsdt: nonnegative,
  funding: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not_applicable") }).strict(),
    z.object({ kind: z.literal("estimate"), costUsdt: nonnegative }).strict(),
  ]),
  assumptionRef: text,
}).strict();

const instrument = z.object({
  instId: text, product, baseCcy: text, quoteCcy: z.literal("USDT"), state: text,
  listTime: z.string().nullable(), tickSz: positive, lotSz: positive, minSz: positive, ctVal: positive.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.product === "spot" && value.ctVal !== null) || (value.product === "usdt_perpetual" && value.ctVal === null)) {
    ctx.addIssue({ code: "custom", path: ["ctVal"], message: "contract value must match the product unit" });
  }
});

const proposal = z.discriminatedUnion("product", [
  z.object({ product: z.literal("spot"), direction: z.literal("long"), baseQuantity: positive, entryPriceUsdt: positive, stopPriceUsdt: positive, costs }).strict(),
  z.object({ product: z.literal("usdt_perpetual"), direction, contracts: positive, entryPriceUsdt: positive, stopPriceUsdt: positive, costs,
    leverage: positive, marginMode: z.enum(["isolated", "cross", "unknown"]), autoAddMargin: z.enum(["off", "on", "unknown"]),
  }).strict(),
]);

const commitment = z.object({
  instId: text, baseCcy: text, product, direction,
  sourceRef: text, valuedAt: instant,
  /** Pending exits retain their original commitment until exchange reconciliation proves release. */
  stage: z.enum(["open", "pending", "unknown"]),
  budgetUsdt: nonnegative, notionalUsdt: nonnegative, plannedLossUsdt: nonnegative, costsUsdt: nonnegative,
}).strict().superRefine((value, ctx) => {
  if (value.product === "spot" && value.direction !== "long") ctx.addIssue({ code: "custom", path: ["direction"], message: "spot commitment cannot be short" });
});

const inputSchema = z.object({
  instrument,
  valuation: z.object({ at: instant, basePriceUsdt: positive, sourceRef: text }).strict(),
  policy: z.object({
    spotBudgetUsdt: nonnegative, perpetualBudgetUsdt: nonnegative,
    maxSpotAssets: z.number().int().nonnegative(), maxPerpetualPositions: z.number().int().nonnegative(),
    maxSpotPlanLossUsdt: nonnegative, maxPerpetualPlanLossUsdt: nonnegative, maxPerpetualLeverage: positive,
  }).strict(),
  portfolio: z.object({ accountReconciled: z.boolean(), lossLedgerBlocksNewRisk: z.boolean(), commitments: z.array(commitment) }).strict(),
  proposal,
}).strict().superRefine((input, ctx) => {
  const identities = new Map<string, { product: string; baseCcy: string }>([[input.instrument.instId, input.instrument]]);
  for (const [index, value] of input.portfolio.commitments.entries()) {
    const existing = identities.get(value.instId);
    if (existing && (existing.product !== value.product || existing.baseCcy !== value.baseCcy)) {
      ctx.addIssue({ code: "custom", path: ["portfolio", "commitments", index], message: "instrument identity is inconsistent" });
    }
    identities.set(value.instId, value);
  }
});

export type EntryRiskInput = z.infer<typeof inputSchema>;
export type RiskCommitment = z.infer<typeof commitment>;

export interface EntrySizing {
  product: "spot" | "usdt_perpetual";
  baseQuantity: string | null;
  contracts: string | null;
  baseExposure: string;
  notionalUsdt: string;
  /** Arithmetic estimate only; actual exchange margin still requires capability/account checks. */
  marginUsdt: string | null;
  costsUsdt: string;
  priceLossUsdt: string;
  plannedLossUsdt: string;
  budgetRequiredUsdt: string;
}

export interface CombinedExposure {
  baseCcy: string;
  spotLongNotionalUsdt: string;
  perpetualLongNotionalUsdt: string;
  perpetualShortNotionalUsdt: string;
  grossNotionalUsdt: string;
  netLongNotionalUsdt: string;
  plannedLossUsdt: string;
  costsUsdt: string;
}

export interface EntryRiskAssessment {
  status: "eligible_for_plan" | "blocked";
  /** A successful arithmetic assessment never grants approval, account capability or execution. */
  executionAuthorized: false;
  violations: Violation[];
  sizing: EntrySizing;
  portfolioAfter: {
    spotBudgetUsedUsdt: string;
    perpetualBudgetUsedUsdt: string;
    spotAssets: number;
    perpetualPositions: number;
    relatedPlanLossUsdt: string;
    valuationAt: string;
    exposures: CombinedExposure[];
  };
}

/** Plan-preparation arithmetic only. This does not reserve capacity or invoke an exchange. */
export function assessEntryRisk(input: EntryRiskInput): EntryRiskAssessment {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("INVALID_INPUT", "invalid entry risk input", parsed.error.issues.map((issue) => ({ ruleId: "entry.schema", field: issue.path.map(String).join(".") })));
  }
  const { instrument: inst, valuation, policy, portfolio, proposal: plan } = parsed.data;
  const violations: Violation[] = [];
  const block = (ruleId: string, field: string) => violations.push({ ruleId, field });
  if (!portfolio.accountReconciled) block("entry.account_reconciled", "portfolio.accountReconciled");
  if (portfolio.lossLedgerBlocksNewRisk) block("entry.loss_ledger_lock", "portfolio.lossLedgerBlocksNewRisk");
  if (inst.state !== "live") block("entry.instrument_live", "instrument.state");
  if (inst.product !== plan.product) block("entry.product_matches", "proposal.product");
  for (const [index, existing] of portfolio.commitments.entries()) {
    if (Date.parse(existing.valuedAt) !== Date.parse(valuation.at)) {
      violations.push({ ruleId: "entry.valuation_time", field: `portfolio.commitments.${index}.valuedAt`, evidenceRef: existing.sourceRef });
    }
  }

  const step = dec(inst.lotSz);
  const requested = dec(plan.product === "spot" ? plan.baseQuantity : plan.contracts);
  const quantity = requested.divToInt(step).mul(step);
  if (quantity.lt(dec(inst.minSz)) || quantity.isZero()) block("entry.minimum_quantity", plan.product === "spot" ? "proposal.baseQuantity" : "proposal.contracts");
  const entry = dec(plan.entryPriceUsdt);
  const stop = dec(plan.stopPriceUsdt);
  if (!entry.mod(dec(inst.tickSz)).isZero()) block("entry.price_tick", "proposal.entryPriceUsdt");
  if (!stop.mod(dec(inst.tickSz)).isZero()) block("entry.price_tick", "proposal.stopPriceUsdt");
  const distance = plan.direction === "long" ? entry.minus(stop) : stop.minus(entry);
  if (!distance.gt(0)) block("entry.stop_direction", "proposal.stopPriceUsdt");
  const funding = plan.costs.funding.kind === "estimate" ? dec(plan.costs.funding.costUsdt) : new Decimal(0);
  if (plan.product === "spot" && plan.costs.funding.kind !== "not_applicable") block("entry.funding_not_applicable", "proposal.costs.funding");
  if (plan.product === "usdt_perpetual" && plan.costs.funding.kind !== "estimate") block("entry.funding_estimate_required", "proposal.costs.funding");
  const totalCosts = dec(plan.costs.feesUsdt).plus(dec(plan.costs.slippageUsdt)).plus(funding);
  // A mismatched product is already blocked; zero prevents inventing a contract value for explanatory metrics.
  const baseExposure = plan.product === "spot" ? quantity : quantity.mul(inst.ctVal === null ? new Decimal(0) : dec(inst.ctVal));
  const notional = baseExposure.mul(entry);
  const priceLoss = baseExposure.mul(Decimal.max(0, distance));
  const plannedLoss = priceLoss.plus(totalCosts);
  let margin: Decimal | null = null;
  if (plan.product === "usdt_perpetual") {
    const leverage = dec(plan.leverage);
    margin = notional.div(leverage);
    if (leverage.lt(1) || leverage.gt(dec(policy.maxPerpetualLeverage))) block("entry.leverage_limit", "proposal.leverage");
    if (plan.marginMode !== "isolated") block("entry.isolated_required", "proposal.marginMode");
    if (plan.autoAddMargin !== "off") block("entry.auto_add_off_required", "proposal.autoAddMargin");
  }
  const budgetRequired = (margin ?? notional).plus(totalCosts);
  const sizing: EntrySizing = {
    product: plan.product, baseQuantity: plan.product === "spot" ? quantity.toFixed() : null,
    contracts: plan.product === "usdt_perpetual" ? quantity.toFixed() : null, baseExposure: baseExposure.toFixed(),
    notionalUsdt: notional.toFixed(), marginUsdt: margin?.toFixed() ?? null, costsUsdt: totalCosts.toFixed(),
    priceLossUsdt: priceLoss.toFixed(), plannedLossUsdt: plannedLoss.toFixed(), budgetRequiredUsdt: budgetRequired.toFixed(),
  };
  const after: RiskCommitment[] = [...portfolio.commitments, {
    instId: inst.instId, baseCcy: inst.baseCcy, product: plan.product, direction: plan.direction, stage: "pending",
    sourceRef: valuation.sourceRef, valuedAt: valuation.at,
    budgetUsdt: budgetRequired.toFixed(), notionalUsdt: baseExposure.mul(dec(valuation.basePriceUsdt)).toFixed(), plannedLossUsdt: plannedLoss.toFixed(), costsUsdt: totalCosts.toFixed(),
  }];
  const spotBudget = sum(after.filter((c) => c.product === "spot"), "budgetUsdt");
  const perpetualBudget = sum(after.filter((c) => c.product === "usdt_perpetual"), "budgetUsdt");
  const spotAssets = new Set(after.filter((c) => c.product === "spot").map((c) => c.baseCcy)).size;
  const perpetualPositions = new Set(after.filter((c) => c.product === "usdt_perpetual").map((c) => `${c.instId}:${c.direction}`)).size;
  const relatedLoss = sum(after.filter((c) => c.product === plan.product && c.baseCcy === inst.baseCcy && c.direction === plan.direction), "plannedLossUsdt");
  if (spotBudget.gt(dec(policy.spotBudgetUsdt))) block("entry.spot_budget", "policy.spotBudgetUsdt");
  if (perpetualBudget.gt(dec(policy.perpetualBudgetUsdt))) block("entry.perpetual_budget", "policy.perpetualBudgetUsdt");
  if (spotAssets > policy.maxSpotAssets) block("entry.spot_assets", "policy.maxSpotAssets");
  if (perpetualPositions > policy.maxPerpetualPositions) block("entry.perpetual_positions", "policy.maxPerpetualPositions");
  if (relatedLoss.gt(dec(plan.product === "spot" ? policy.maxSpotPlanLossUsdt : policy.maxPerpetualPlanLossUsdt))) {
    block(plan.product === "spot" ? "entry.spot_plan_loss" : "entry.perpetual_plan_loss", "proposal");
  }
  return {
    status: violations.length === 0 ? "eligible_for_plan" : "blocked", executionAuthorized: false, violations, sizing,
    portfolioAfter: { spotBudgetUsedUsdt: spotBudget.toFixed(), perpetualBudgetUsedUsdt: perpetualBudget.toFixed(), spotAssets, perpetualPositions,
      relatedPlanLossUsdt: relatedLoss.toFixed(), valuationAt: valuation.at, exposures: combinedExposures(after) },
  };
}

function sum(values: RiskCommitment[], field: "budgetUsdt" | "notionalUsdt" | "plannedLossUsdt" | "costsUsdt"): Decimal {
  return values.reduce((total, value) => total.plus(dec(value[field])), new Decimal(0));
}

function combinedExposures(values: RiskCommitment[]): CombinedExposure[] {
  return [...new Set(values.map((c) => c.baseCcy))].sort().map((baseCcy) => {
    const matching = values.filter((c) => c.baseCcy === baseCcy);
    const spot = sum(matching.filter((c) => c.product === "spot"), "notionalUsdt");
    const long = sum(matching.filter((c) => c.product === "usdt_perpetual" && c.direction === "long"), "notionalUsdt");
    const short = sum(matching.filter((c) => c.product === "usdt_perpetual" && c.direction === "short"), "notionalUsdt");
    return { baseCcy, spotLongNotionalUsdt: spot.toFixed(), perpetualLongNotionalUsdt: long.toFixed(), perpetualShortNotionalUsdt: short.toFixed(),
      grossNotionalUsdt: spot.plus(long).plus(short).toFixed(), netLongNotionalUsdt: spot.plus(long).minus(short).toFixed(),
      plannedLossUsdt: sum(matching, "plannedLossUsdt").toFixed(), costsUsdt: sum(matching, "costsUsdt").toFixed() };
  });
}
