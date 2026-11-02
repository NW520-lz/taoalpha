import { z } from 'zod';
import { Decimal, dec, isDecimalString } from '../risk/risk-decimal.ts';
import { hashJson } from '../lib/hash.ts';
import { DomainError } from '../lib/errors.ts';
import { assessEntryRisk, type EntryRiskInput } from '../risk/entry-risk.ts';

const text = z.string().trim().min(1).max(200);
const positive = z.string().max(64).refine(v => isDecimalString(v) && dec(v).gt(0));
const ppm = z.number().int().min(0).max(1_000_000);
const inputSchema = z.strictObject({
 scope: z.strictObject({ scopeId: text, accountRef: text, site: z.enum(['global', 'eea', 'us', 'tr']), environment: z.literal('demo') }),
 strategy: z.strictObject({ id: text, version: z.number().int().positive(), validation: z.enum(['unvalidated', 'validated']) }),
 signal: z.strictObject({ instId: text, product: z.literal('spot'), direction: z.literal('long'), signalCloseAt: z.iso.datetime({ offset: true }), atrUsdt: positive, initialStopAtr: positive, trailingStopAtr: positive, evidenceRefs: z.array(text).min(1).max(50) }),
 quote: z.strictObject({ priceUsdt: positive, at: z.iso.datetime({ offset: true }), sourceRef: text, maxAgeSeconds: z.number().int().min(1).max(3600) }),
 instrument: z.unknown(),
 costModel: z.strictObject({ feePpm: ppm, slippagePpm: ppm, assumptionRef: text }),
 riskPolicy: z.strictObject({ version: z.number().int().positive(), spotBudgetUsdt: z.string(), perpetualBudgetUsdt: z.string(), maxSpotAssets: z.number(), maxPerpetualPositions: z.number(), maxSpotPlanLossUsdt: z.string(), maxPerpetualPlanLossUsdt: z.string(), maxPerpetualLeverage: z.string() }),
 maxPlanLossUsdt: positive,
 portfolio: z.unknown(),
 validForSeconds: z.number().int().min(60).max(86400),
});
export type DemoCardInput = z.infer<typeof inputSchema>;

const floorTo = (value: Decimal, step: Decimal) => value.divToInt(step).mul(step);

/**
 * Compiles one spot-long demo trade card: quantity sized so the planned loss (price distance to the initial
 * stop plus fees and slippage on both sides) stays within the smaller of the card limit and the risk policy,
 * an initial stop at entry - k1 x ATR and an exchange trailing stop with its callback spread frozen at
 * k2 x ATR (ADR-011). Pure: it neither stores the card nor grants approval or execution.
 */
export function compileDemoCard(raw: unknown, now: () => Date) {
 const parsed = inputSchema.safeParse(raw);
 // The instrument's own schema is checked by the risk assessment; its identity must match the signal here.
 const named = parsed.success && (parsed.data.instrument as { instId?: unknown; product?: unknown } | null)?.instId === parsed.data.signal.instId
  && (parsed.data.instrument as { product?: unknown }).product === parsed.data.signal.product;
 if (!parsed.success || !named) throw new DomainError('INVALID_INPUT', 'Trade card input rejected', [{ ruleId: 'card.schema' }]);
 const input = parsed.data, at = now();
 const blocked = (reasons: string[]) => ({ outcome: 'blocked' as const, reasons, card: null });
 // A quote from the future or older than its allowed age cannot price a card.
 const quoteAge = at.getTime() - Date.parse(input.quote.at);
 // Exchange timestamps may lead the local clock a little (observed ~4.5 s); beyond 10 s the quote is not trusted.
 if (quoteAge < -10_000 || quoteAge > input.quote.maxAgeSeconds * 1000) return blocked(['card.quote_stale']);
 const instrument = input.instrument as EntryRiskInput['instrument'];
 const tick = dec(instrument.tickSz), lot = dec(instrument.lotSz);
 const entry = floorTo(dec(input.quote.priceUsdt), tick), atr = dec(input.signal.atrUsdt);
 const stop = floorTo(entry.minus(atr.times(input.signal.initialStopAtr)), tick);
 const callback = floorTo(atr.times(input.signal.trailingStopAtr), tick);
 const costRate = new Decimal(input.costModel.feePpm + input.costModel.slippagePpm).div(1_000_000);
 const limit = Decimal.min(dec(input.maxPlanLossUsdt), dec(input.riskPolicy.maxSpotPlanLossUsdt));
 const perUnit = entry.minus(stop).plus(entry.plus(stop).times(costRate));
 const quantity = floorTo(limit.div(perUnit), lot);
 const sideNotional = quantity.times(entry.plus(stop));
 const fees = sideNotional.times(input.costModel.feePpm).div(1_000_000), slippage = sideNotional.times(input.costModel.slippagePpm).div(1_000_000);
 const { version: _policyVersion, ...policy } = input.riskPolicy;
 const risk = assessEntryRisk({ instrument, valuation: { at: input.quote.at, basePriceUsdt: entry.toFixed(), sourceRef: input.quote.sourceRef }, policy,
  portfolio: input.portfolio as EntryRiskInput['portfolio'],
  proposal: { product: 'spot', direction: 'long', baseQuantity: quantity.toFixed(), entryPriceUsdt: entry.toFixed(), stopPriceUsdt: stop.toFixed(),
   costs: { feesUsdt: fees.toFixed(), slippageUsdt: slippage.toFixed(), funding: { kind: 'not_applicable' }, assumptionRef: input.costModel.assumptionRef } } });
 if (risk.status !== 'eligible_for_plan') return blocked([...new Set(risk.violations.map(v => v.ruleId))]);
 const body = {
  cardVersion: 1 as const, environment: input.scope.environment, scope: input.scope,
  strategy: input.strategy, label: input.strategy.validation === 'validated' ? 'validated_strategy' as const : 'pipeline_test_unvalidated_strategy' as const,
  instrument: { instId: input.signal.instId, product: input.signal.product }, direction: input.signal.direction,
  baseQuantity: quantity.toFixed(), entry: { kind: 'market' as const, referencePriceUsdt: entry.toFixed(), quotedAt: input.quote.at, quoteRef: input.quote.sourceRef },
  protection: { initialStopPriceUsdt: stop.toFixed(), trailing: { kind: 'move_order_stop' as const, callbackSpreadUsdt: callback.toFixed(), frozenAtSignal: input.signal.signalCloseAt } },
  risk: { plannedLossUsdt: risk.sizing.plannedLossUsdt, priceLossUsdt: risk.sizing.priceLossUsdt, feesUsdt: fees.toFixed(), slippageUsdt: slippage.toFixed(), notionalUsdt: risk.sizing.notionalUsdt, budgetRequiredUsdt: risk.sizing.budgetRequiredUsdt, maxPlanLossUsdt: limit.toFixed(), riskPolicyVersion: input.riskPolicy.version, costAssumptionRef: input.costModel.assumptionRef },
  // Approved with the card (I-05, I-17, I-18): what the executor may do when a step fails.
  exceptionPolicy: { protectionMissingOrUnknown: 'lock_new_risk_cancel_remaining_entry_exit_this_intent_exposure' as const, takeProfitFailedStopActive: 'stop_adding_risk_keep_stop' as const, unknownSubmission: 'query_by_client_order_id_never_resend_entry' as const },
  evidenceRefs: input.signal.evidenceRefs, createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + input.validForSeconds * 1000).toISOString(),
 };
 return { outcome: 'compiled' as const, reasons: [] as string[], card: { ...body, contentSha256: hashJson(body), executable: false as const } };
}
