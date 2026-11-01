import {z} from 'zod';
import {dec,isDecimalString} from '../lib/decimal.ts';

const positiveDecimal=z.string().max(32).refine(v=>isDecimalString(v) && dec(v).gt(0));
// Neighbourhood values are listed explicitly (so integer rounding is frozen) and strictly increasing.
const intValues=(min:number)=>z.array(z.number().int().min(1).max(1000)).min(min).max(20).refine(v=>v.every((x,i)=>i===0 || x>v[i-1]!));
const decimalValues=(min:number)=>z.array(positiveDecimal).min(min).max(20).refine(v=>v.every((x,i)=>i===0 || dec(x).gt(dec(v[i-1]!))));
const nonNegativeDecimal=z.string().max(32).refine(v=>isDecimalString(v) && dec(v).gte(0));
/**
 * Evaluation gates frozen with an experiment registration. Every value is supplied by whoever
 * registers the experiment; there are no defaults, and a change requires a new experiment version.
 */
export const evaluationGatesSchema=z.strictObject({
 minRealizedTrades:z.number().int().min(1).max(1000000),
 maxValidationDecay:nonNegativeDecimal,
 normalizationDays:z.number().int().min(1).max(3650),
 requirePositiveNet:z.boolean(),
 // Cost stress: fees and impact are each multiplied; must include 1 to show the base case.
 // Parameter sensitivity, run on the exploration window only.
 sensitivity:z.strictObject({
  neighbourhoods:z.strictObject({breakoutLookback:intValues(2).optional(),atrPeriod:intValues(2).optional(),initialStopAtr:decimalValues(2).optional(),trailingStopAtr:decimalValues(2).optional()}).refine(n=>Object.keys(n).length>0),
  stopGrid:z.strictObject({initialStopAtr:decimalValues(1),trailingStopAtr:decimalValues(1)}).optional(),
  maxAdjacentChange:nonNegativeDecimal,
  requireAllPositive:z.boolean(),
 }).optional(),
 costStressMultipliers:z.array(z.number().int().min(1).max(1000)).min(1).max(10).refine(m=>m[0]===1 && m.every((v,i)=>i===0 || v>m[i-1]!)).optional(),
});
export type EvaluationGates=z.infer<typeof evaluationGatesSchema>;
