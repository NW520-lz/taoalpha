import {z} from 'zod';
import {Decimal} from '../lib/decimal.ts';
import {DomainError} from '../lib/errors.ts';
import {getBundle} from '../store/evidence-store.ts';
import type {Db} from '../store/db.ts';
import {loadRegisteredExperiment,type Registry} from './registered-replay.ts';
import {simulateRelativeStrength,vetoKey} from './relative-strength.ts';
import {parseReplayInput} from './research-evaluation.ts';
import {getRun,type ResearchRunView} from './research-service.ts';

const requestSchema=z.strictObject({experimentId:z.string(),version:z.number(),expected:z.unknown(),window:z.enum(['exploration','validation','evaluation'])});
type Rejection='research_run_missing'|'research_unfinished'|'evidence_after_signal';

// Only an unknown run counts as missing; integrity or storage failures propagate.
function findRun(db:Db,runId:string):ResearchRunView|null {
 try { return getRun(db,runId); }
 catch(error) { if(error instanceof DomainError && error.violations.some(v=>v.ruleId==='research.run_exists')) return null; throw error; }
}

/**
 * Compares the registered universe replay with and without its frozen agent vetoes. A veto applies only
 * when its research run decided and both that decision and its evidence bundle existed by the signal's close;
 * evidence gathered later could not have informed that decision. Agent counts and confidence are never
 * treated as win rates, and the host's way of running agents stays unverified.
 */
export function compareAgentVeto(db:Db,registry:Registry,raw:unknown) {
 const request=parseReplayInput(requestSchema,raw);
 if(request.window==='evaluation') throw new DomainError('UNSUPPORTED_CAPABILITY','Evaluation window is sealed',[{ruleId:'experiment.evaluation_window_sealed'}]);
 const loaded=loadRegisteredExperiment(db,registry,request);
 const {registration,resolutionMs}=loaded;
 const unknowns=['agent_call_cost_unrecorded','agent_reports_not_statistically_independent','host_agent_execution_unverified'];
 const base={experimentId:request.experimentId,version:request.version,window:request.window,registrationSha256:registration.contentSha256,status:'insufficient' as const,executionAuthorized:false as const,unknowns};
 if(!registration.agentVetoes || !registration.replay?.selection || !registration.universe) return {...base,outcome:'blocked' as const,reasonCode:'rules_incomplete' as const,appliedVetoes:[],rejectedVetoes:null,researchRuns:null,rulesOnly:null,withVeto:null,netDifferenceUsdt:null};
 const runs=new Map<string,ResearchRunView>();
 const applied:typeof registration.agentVetoes=[], rejected:Array<typeof registration.agentVetoes[number] & {reason:Rejection}>=[];
 for(const veto of registration.agentVetoes) {
  const run=findRun(db,veto.researchRunId);
  if(!run){rejected.push({...veto,reason:'research_run_missing'});continue;}
  runs.set(run.runId,run);
  if(!run.decision){rejected.push({...veto,reason:'research_unfinished'});continue;}
  // The veto exists only once the run decided; its evidence bundle must also predate the signal.
  const knownAt=Math.max(Date.parse(run.decision.decidedAt),Date.parse(getBundle(db,run.bundleId)!.createdAt));
  if(knownAt>veto.signalOpenMs+resolutionMs){rejected.push({...veto,reason:'evidence_after_signal'});continue;}
  applied.push(veto);
 }
 const rulesOnly=simulateRelativeStrength(db,loaded,request.window,new Set()).metrics;
 const withVeto=simulateRelativeStrength(db,loaded,request.window,new Set(applied.map(v=>vetoKey(v.instId,v.signalOpenMs)))).metrics;
 const difference=rulesOnly?.netUsdt!=null && withVeto?.netUsdt!=null ? new Decimal(withVeto.netUsdt).minus(rulesOnly.netUsdt).toFixed() : null;
 return {...base,outcome:'compared' as const,reasonCode:null,appliedVetoes:applied,rejectedVetoes:rejected,
  researchRuns:[...runs.values()].map(r=>({runId:r.runId,agentMode:r.agentMode,hostVerified:r.hostVerified})),
  rulesOnly,withVeto,netDifferenceUsdt:difference};
}
