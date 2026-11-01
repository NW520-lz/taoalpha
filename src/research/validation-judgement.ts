import {z} from 'zod';
import {Decimal} from '../lib/decimal.ts';
import type {Db} from '../store/db.ts';
import type {EvaluationGates} from './gates.ts';
import {loadRegisteredExperiment,replayWindow,type LoadedExperiment,type Registry} from './registered-replay.ts';
import {parseReplayInput} from './research-evaluation.ts';

const requestSchema=z.strictObject({experimentId:z.string(),version:z.number(),expected:z.unknown()});
const DAY_MS=86400000;
type Window=ReturnType<typeof replayWindow>;

/** Window net scaled to a common period so windows of different lengths compare. */
function normalizedNet(window:Window,days:number,resolutionMs:number):Decimal|null {
 const net=window.metrics?.netUsdt;
 // Scale by the bars actually covered, so missing data neither shrinks nor inflates the rate.
 const covered=window.segments.reduce((ms,s)=>ms+s.candles*resolutionMs,0);
 return net==null ? null : new Decimal(net).times(days*DAY_MS).div(covered);
}

/** Applies the frozen gates to exploration and validation. Never yields `passed`; that is the final report's job. */
export function judgeExplorationAndValidation(loaded:LoadedExperiment,gates:EvaluationGates) {
 const exploration=replayWindow(loaded,'exploration'), validation=replayWindow(loaded,'validation');
 const explorationNet=normalizedNet(exploration,gates.normalizationDays,loaded.resolutionMs), validationNet=normalizedNet(validation,gates.normalizationDays,loaded.resolutionMs);
 const insufficient:string[]=[], failed:string[]=[];
 if(!exploration.metrics || !validation.metrics) insufficient.push('window_missing_evidence');
 else {
  if(exploration.metrics.realizedTrades<gates.minRealizedTrades) insufficient.push('exploration_trades_below_minimum');
  if(validation.metrics.realizedTrades===0) insufficient.push('validation_no_realized_trades');
 }
 // A decay ratio is only meaningful against a positive exploration result.
 const decay=explorationNet?.gt(0) && validationNet ? explorationNet.minus(validationNet).div(explorationNet).toDecimalPlaces(10,Decimal.ROUND_HALF_EVEN) : null;
 if(explorationNet && !explorationNet.gt(0)) failed.push('exploration_net_not_positive');
 if(gates.requirePositiveNet && validationNet && !validationNet.gt(0)) failed.push('validation_net_not_positive');
 if(decay && decay.gt(gates.maxValidationDecay)) failed.push('validation_decay_above_limit');
 // Too little evidence outranks a failure: the sample cannot decide either way yet.
 const validationGate=insufficient.length ? 'insufficient' as const : failed.length ? 'failed' as const : 'met' as const;
 return {
  exploration:{...exploration,normalizedNetUsdt:explorationNet?.toFixed() ?? null},
  validation:{...validation,normalizedNetUsdt:validationNet?.toFixed() ?? null},
  decay:decay?.toFixed() ?? null,validationGate,reasons:[...failed,...insufficient],
 };
}

/** Read-only judgement of a registered experiment's exploration and validation windows against its frozen gates. */
export function judgeValidation(db:Db,registry:Registry,raw:unknown) {
 const request=parseReplayInput(requestSchema,raw);
 const loaded=loadRegisteredExperiment(db,registry,request);
 const {registration}=loaded;
 const base={experimentId:request.experimentId,version:request.version,registrationSha256:registration.contentSha256,status:'insufficient' as const,executionAuthorized:false as const};
 // Prose thresholds are never interpreted; only frozen structured gates are applied.
 if(!registration.gates) return {...base,outcome:'blocked' as const,reasonCode:'rules_incomplete' as const,exploration:null,validation:null,decay:null,validationGate:null,reasons:[]};
 return {...base,outcome:'judged' as const,reasonCode:null,...judgeExplorationAndValidation(loaded,registration.gates)};
}
