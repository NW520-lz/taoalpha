import { test } from "node:test";
import assert from "node:assert/strict";
import type { Instrument } from "../../src/market/instruments.ts";
import { assessEntryRisk, type EntryRiskInput, type RiskCommitment } from "../../src/risk/entry-risk.ts";

function spotInput(): EntryRiskInput {
  const instrument: Instrument = { instId: "SYN-USDT", product: "spot", baseCcy: "SYN", quoteCcy: "USDT", state: "live", listTime: null, tickSz: "0.1", lotSz: "0.1", minSz: "0.1", ctVal: null };
  return {
    instrument,
    valuation: { at: "2026-10-28T12:00:00Z", basePriceUsdt: "20", sourceRef: "synthetic-price" },
    policy: { spotBudgetUsdt: "150", perpetualBudgetUsdt: "50", maxSpotAssets: 3, maxPerpetualPositions: 2, maxSpotPlanLossUsdt: "8", maxPerpetualPlanLossUsdt: "2", maxPerpetualLeverage: "3" },
    portfolio: { accountReconciled: true, lossLedgerBlocksNewRisk: false, commitments: [] },
    proposal: { product: "spot", direction: "long", baseQuantity: "2.09", entryPriceUsdt: "20", stopPriceUsdt: "18", costs: { feesUsdt: "0.2", slippageUsdt: "0.1", funding: { kind: "not_applicable" }, assumptionRef: "synthetic-cost-model" } },
  };
}

function perpetualInput(): EntryRiskInput {
  const input = spotInput();
  return {
    ...input,
    valuation: { ...input.valuation, basePriceUsdt: "200" },
    instrument: { ...input.instrument, instId: "SYN-USDT-SWAP", product: "usdt_perpetual", lotSz: "1", minSz: "1", ctVal: "0.1" },
    proposal: { product: "usdt_perpetual", direction: "long", contracts: "3.9", entryPriceUsdt: "200", stopPriceUsdt: "195", leverage: "3", marginMode: "isolated", autoAddMargin: "off", costs: { feesUsdt: "0.2", slippageUsdt: "0.1", funding: { kind: "estimate", costUsdt: "0.05" }, assumptionRef: "synthetic-cost-model" } },
  };
}

function commitment(overrides: Partial<RiskCommitment> = {}): RiskCommitment {
  return { instId: "OLD-USDT", baseCcy: "OLD", product: "spot", direction: "long", sourceRef: "synthetic-position", valuedAt: "2026-10-28T12:00:00Z", stage: "open", budgetUsdt: "40", notionalUsdt: "40", plannedLossUsdt: "2", costsUsdt: "0.2", ...overrides };
}

function rules(input: EntryRiskInput): string[] {
  return assessEntryRisk(input).violations.map((v) => v.ruleId);
}

test("tiny positive cost cannot disappear at the budget boundary", () => {
  const input = spotInput();
  if (input.proposal.product !== "spot") throw new Error("fixture");
  input.instrument.lotSz = "1";
  input.instrument.minSz = "1";
  input.proposal.baseQuantity = "1";
  input.proposal.entryPriceUsdt = "1";
  input.proposal.stopPriceUsdt = "0.5";
  input.proposal.costs.feesUsdt = `0.${"0".repeat(50)}1`;
  input.proposal.costs.slippageUsdt = "0";
  input.policy.spotBudgetUsdt = "1";
  assert.ok(rules(input).includes("entry.spot_budget"));
});

test("quantity infinitesimally below a lot cannot round up", () => {
  const input = spotInput();
  if (input.proposal.product !== "spot") throw new Error("fixture");
  input.instrument.lotSz = "1";
  input.instrument.minSz = "1";
  input.proposal.baseQuantity = `0.${"9".repeat(51)}`;
  const result = assessEntryRisk(input);
  assert.equal(result.sizing.baseQuantity, "0");
  assert.ok(result.violations.some((v) => v.ruleId === "entry.minimum_quantity"));
});

test("nonterminating margin is rounded conservatively above a truncated budget", () => {
  const input = perpetualInput();
  if (input.proposal.product !== "usdt_perpetual") throw new Error("fixture");
  input.instrument.ctVal = "1";
  input.proposal.contracts = "1";
  input.proposal.entryPriceUsdt = "1";
  input.proposal.stopPriceUsdt = "0.5";
  input.proposal.leverage = "3";
  input.proposal.costs.feesUsdt = "0";
  input.proposal.costs.slippageUsdt = "0";
  input.proposal.costs.funding = { kind: "estimate", costUsdt: "0" };
  input.policy.perpetualBudgetUsdt = `0.${"3".repeat(200)}`;
  assert.ok(rules(input).includes("entry.perpetual_budget"));
});

test("risk input rejects decimals beyond the supported length", () => {
  const input = spotInput();
  input.policy.spotBudgetUsdt = `0.${"0".repeat(255)}1`;
  assert.throws(() => assessEntryRisk(input), /invalid entry risk input/);
});

test("spot quantity rounds down before loss and budget are calculated, with units kept explicit", () => {
  const result = assessEntryRisk(spotInput());
  assert.equal(result.status, "eligible_for_plan");
  assert.equal(result.executionAuthorized, false);
  assert.deepEqual(result.sizing, { product: "spot", baseQuantity: "2", contracts: null, baseExposure: "2", notionalUsdt: "40", marginUsdt: null, costsUsdt: "0.3", priceLossUsdt: "4", plannedLossUsdt: "4.3", budgetRequiredUsdt: "40.3" });
  assert.equal(result.portfolioAfter.spotBudgetUsedUsdt, "40.3");
  assert.equal(result.portfolioAfter.spotAssets, 1);
});

test("a quantity below the exchange minimum is rejected instead of rounding up to consume more risk", () => {
  const input = spotInput();
  assert.equal(input.proposal.product, "spot");
  input.proposal = { ...input.proposal, product: "spot", direction: "long", baseQuantity: "0.09" };
  const result = assessEntryRisk(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.violations.some((v) => v.ruleId === "entry.minimum_quantity"));
  assert.equal(result.sizing.baseQuantity, "0");
});

test("perpetual contracts convert through ctVal and leverage never replaces stop-distance risk", () => {
  const result = assessEntryRisk(perpetualInput());
  assert.equal(result.status, "eligible_for_plan");
  assert.deepEqual(result.sizing, { product: "usdt_perpetual", baseQuantity: null, contracts: "3", baseExposure: "0.3", notionalUsdt: "60", marginUsdt: "20", costsUsdt: "0.35", priceLossUsdt: "1.5", plannedLossUsdt: "1.85", budgetRequiredUsdt: "20.35" });
  const input = perpetualInput();
  if (input.proposal.product !== "usdt_perpetual") throw new Error("fixture");
  input.proposal.leverage = "1";
  const unlevered = assessEntryRisk(input);
  assert.equal(unlevered.sizing.plannedLossUsdt, result.sizing.plannedLossUsdt);
  assert.equal(unlevered.sizing.marginUsdt, "60");
  assert.ok(unlevered.violations.some((v) => v.ruleId === "entry.perpetual_budget"));
});

test("short stops must be above entry and isolated mode, auto-add state and leverage are checked", () => {
  const input = perpetualInput();
  if (input.proposal.product !== "usdt_perpetual") throw new Error("fixture");
  input.proposal = { ...input.proposal, direction: "short", stopPriceUsdt: "205" };
  assert.equal(assessEntryRisk(input).sizing.priceLossUsdt, "1.5");
  input.proposal = { ...input.proposal, stopPriceUsdt: "195", leverage: "4", marginMode: "cross", autoAddMargin: "unknown" };
  const found = rules(input);
  for (const rule of ["entry.stop_direction", "entry.leverage_limit", "entry.isolated_required", "entry.auto_add_off_required"]) assert.ok(found.includes(rule), rule);
});

test("pending and unknown entries consume budget and position slots until reconciliation releases them", () => {
  const input = perpetualInput();
  input.portfolio.commitments = [
    commitment({ product: "usdt_perpetual", instId: "ONE-USDT-SWAP", baseCcy: "ONE", stage: "pending", budgetUsdt: "20" }),
    commitment({ product: "usdt_perpetual", instId: "TWO-USDT-SWAP", baseCcy: "TWO", stage: "unknown", budgetUsdt: "15" }),
  ];
  const result = assessEntryRisk(input);
  assert.ok(result.violations.some((v) => v.ruleId === "entry.perpetual_budget"));
  assert.ok(result.violations.some((v) => v.ruleId === "entry.perpetual_positions"));
  assert.equal(result.portfolioAfter.perpetualPositions, 3);
  assert.equal(result.portfolioAfter.perpetualBudgetUsedUsdt, "55.35");
});

test("related same-coin entries aggregate their planned loss even when split across open and pending orders", () => {
  const input = spotInput();
  input.portfolio.commitments = [commitment({ instId: "SYN-USDT", baseCcy: "SYN", plannedLossUsdt: "3.8", stage: "pending" })];
  const result = assessEntryRisk(input);
  assert.ok(result.violations.some((v) => v.ruleId === "entry.spot_plan_loss"));
  assert.equal(result.portfolioAfter.spotAssets, 1);
  assert.equal(result.portfolioAfter.relatedPlanLossUsdt, "8.1");
});

test("opposite spot and perpetual exposure shows gross and net separately without offsetting risk or budget", () => {
  const input = spotInput();
  input.portfolio.commitments = [commitment({ instId: "SYN-USDT-SWAP", baseCcy: "SYN", product: "usdt_perpetual", direction: "short", budgetUsdt: "15", plannedLossUsdt: "1.2", costsUsdt: "0.4" })];
  const result = assessEntryRisk(input);
  assert.equal(result.status, "eligible_for_plan");
  assert.deepEqual(result.portfolioAfter.exposures, [{ baseCcy: "SYN", spotLongNotionalUsdt: "40", perpetualLongNotionalUsdt: "0", perpetualShortNotionalUsdt: "40", grossNotionalUsdt: "80", netLongNotionalUsdt: "0", plannedLossUsdt: "5.5", costsUsdt: "0.7" }]);
  assert.equal(result.portfolioAfter.spotBudgetUsedUsdt, "40.3");
  assert.equal(result.portfolioAfter.perpetualBudgetUsedUsdt, "15");
});

test("spot asset capacity and its budget are independent limits; reserves are never borrowed", () => {
  const input = spotInput();
  input.portfolio.commitments = [commitment({ baseCcy: "ONE", instId: "ONE-USDT", budgetUsdt: "40" }), commitment({ baseCcy: "TWO", instId: "TWO-USDT", budgetUsdt: "40" }), commitment({ baseCcy: "THREE", instId: "THREE-USDT", budgetUsdt: "40" })];
  const found = rules(input);
  assert.ok(found.includes("entry.spot_budget"));
  assert.ok(found.includes("entry.spot_assets"));
});

test("unreconciled accounts, existing loss locks, inactive products and off-tick prices block plan eligibility", () => {
  const input = spotInput();
  input.portfolio.accountReconciled = false;
  input.portfolio.lossLedgerBlocksNewRisk = true;
  input.instrument.state = "suspend";
  input.proposal.entryPriceUsdt = "20.01";
  const found = rules(input);
  for (const rule of ["entry.account_reconciled", "entry.loss_ledger_lock", "entry.instrument_live", "entry.price_tick"]) assert.ok(found.includes(rule), rule);
});

test("budget and planned-loss limits accept the exact boundary and reject any excess", () => {
  const input = spotInput();
  input.policy.spotBudgetUsdt = "40.3";
  input.policy.maxSpotPlanLossUsdt = "4.3";
  assert.equal(assessEntryRisk(input).status, "eligible_for_plan");
  input.policy.spotBudgetUsdt = "40.299999999999999999";
  input.policy.maxSpotPlanLossUsdt = "4.299999999999999999";
  const found = rules(input);
  assert.ok(found.includes("entry.spot_budget"));
  assert.ok(found.includes("entry.spot_plan_loss"));
});

test("combined exposure uses one valuation time and a distinct valuation price from the entry price", () => {
  const input = spotInput();
  input.valuation.basePriceUsdt = "21";
  input.portfolio.commitments = [commitment({ instId: "SYN-USDT-SWAP", baseCcy: "SYN", product: "usdt_perpetual", direction: "short", valuedAt: "2026-10-28T11:59:00Z" })];
  const result = assessEntryRisk(input);
  assert.equal(result.sizing.notionalUsdt, "40", "budget uses the planned entry price");
  assert.equal(result.portfolioAfter.exposures[0]?.spotLongNotionalUsdt, "42", "exposure uses the common valuation price");
  assert.equal(result.status, "blocked");
  assert.ok(result.violations.some((v) => v.ruleId === "entry.valuation_time" && v.evidenceRef === "synthetic-position"));
});

test("costs and product units are runtime validated; unknown funding costs cannot masquerade as zero", () => {
  const input = perpetualInput();
  if (input.proposal.product !== "usdt_perpetual") throw new Error("fixture");
  input.proposal.costs.funding = { kind: "not_applicable" };
  assert.ok(rules(input).includes("entry.funding_estimate_required"));
  input.proposal.costs.feesUsdt = "-1";
  assert.throws(() => assessEntryRisk(input), /invalid entry risk input/);
  input.proposal.costs.feesUsdt = "0.2";
  input.instrument.ctVal = "0";
  assert.throws(() => assessEntryRisk(input), /invalid entry risk input/);
});
