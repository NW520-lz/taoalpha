import {z} from 'zod';
import {Decimal} from '../lib/decimal.ts';
import type {Db} from '../store/db.ts';
import type {EvaluationGates} from './gates.ts';
import {loadRegisteredExperiment,replayWindow,type LoadedExperiment,type Registry,type TrendReplay} from './registered-replay.ts';
import {parseReplayInput} from './research-evaluation.ts';

const requestSchema=z.strictObject({experimentId:z.string(),version:z.number(),expected:z.unknown()});
type Sensitivity=NonNullable<EvaluationGates['sensitivity']>;
type Parameter=keyof Sensitivity['neighbourhoods'];
const PARAMETERS:Parameter[]=['breakoutLookback','atrPeriod','initialStopAtr','trailingStopAtr'];

/**
 * One-at-a-time neighbourhood replays plus the optional stop grid, on the exploration window only.
 * Every point is enumerated from the frozen registration, so the set of attempts cannot be cherry-picked.
 */
export function assessSensitivity(loaded:LoadedExperiment,replay:TrendReplay,sensitivity:Sensitivity) {
 const net=(rule:Partial<TrendReplay['rule']>)=>replayWindow(loaded,'exploration',{...replay,rule:{...replay.rule,...rule}}).metrics?.netUsdt ?? null;
 const failed:string[]=[], insufficient:string[]=[];
 const parameters=PARAMETERS.filter(p=>sensitivity.neighbourhoods[p]).map(parameter=>{
  const points=(sensitivity.neighbourhoods[parameter] as Array<number|string>).map(value=>({value,netUsdt:net({[parameter]:value})}));
  // Relative change from each point to the next; undefined when either side has no result or the base is zero.
  const adjacentChanges=points.slice(1).map((p,i)=>{const prev=points[i]!.netUsdt;return prev===null || p.netUsdt===null || new Decimal(prev).isZero() ? null : new Decimal(p.netUsdt).minus(prev).abs().div(new Decimal(prev).abs()).toDecimalPlaces(10,Decimal.ROUND_HALF_EVEN).toFixed();});
  if(points.some(p=>p.netUsdt===null)) insufficient.push(`${parameter}_point_without_trades`);
  if(sensitivity.requireAllPositive && points.some(p=>p.netUsdt!==null && !new Decimal(p.netUsdt).gt(0))) failed.push(`${parameter}_not_all_positive`);
  if(adjacentChanges.some(c=>c!==null && new Decimal(c).gt(sensitivity.maxAdjacentChange))) failed.push(`${parameter}_adjacent_change_above_limit`);
  return {parameter,points,adjacentChanges};
 });
 // The initial stop only matters while it sits above entry minus the trailing distance.
 const stopGrid=sensitivity.stopGrid ? sensitivity.stopGrid.initialStopAtr.flatMap(initialStopAtr=>sensitivity.stopGrid!.trailingStopAtr.map(trailingStopAtr=>({initialStopAtr,trailingStopAtr,netUsdt:net({initialStopAtr,trailingStopAtr}),initialStopCanBind:new Decimal(trailingStopAtr).gt(initialStopAtr)}))) : null;
 const attempts=parameters.reduce((n,p)=>n+p.points.length,0)+(stopGrid?.length ?? 0);
 const sensitivityGate=failed.length ? 'failed' as const : insufficient.length ? 'insufficient' as const : 'met' as const;
 return {window:'exploration' as const,parameters,stopGrid,attempts,sensitivityGate,reasons:[...failed,...insufficient]};
}

/** Read-only parameter sensitivity of a registered experiment's exploration window. */
export function assessParameterSensitivity(db:Db,registry:Registry,raw:unknown) {
 const request=parseReplayInput(requestSchema,raw);
 const loaded=loadRegisteredExperiment(db,registry,request);
 const {registration}=loaded;
 const base={experimentId:request.experimentId,version:request.version,registrationSha256:registration.contentSha256,status:'insufficient' as const,executionAuthorized:false as const};
 if(!registration.replay || !registration.gates?.sensitivity) return {...base,outcome:'blocked' as const,reasonCode:'rules_incomplete' as const,window:'exploration' as const,parameters:null,stopGrid:null,attempts:0,sensitivityGate:null,reasons:[]};
 return {...base,outcome:'assessed' as const,reasonCode:null,...assessSensitivity(loaded,registration.replay,registration.gates.sensitivity)};
}
