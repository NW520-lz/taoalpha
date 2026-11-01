import {z} from 'zod';
import {dec,isDecimalString} from '../lib/decimal.ts';

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
});
export type EvaluationGates=z.infer<typeof evaluationGatesSchema>;
