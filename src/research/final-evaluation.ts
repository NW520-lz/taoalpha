import {z} from 'zod';
import {Decimal} from '../lib/decimal.ts';
import {DomainError} from '../lib/errors.ts';
import {canonicalJson,sha256} from '../lib/hash.ts';
import {inTransaction,type Db} from '../store/db.ts';
import {stressAndBaselines} from './baselines.ts';
import {loadRegisteredExperiment,replayWindow,type Registry} from './registered-replay.ts';
import {parseReplayInput} from './research-evaluation.ts';
import {assessSensitivity} from './sensitivity.ts';
import {judgeExplorationAndValidation} from './validation-judgement.ts';

const requestSchema=z.strictObject({experimentId:z.string(),version:z.number(),expected:z.unknown()});
// Evidence the current history manifests cannot supply; while unknown, a report cannot be `passed`.
const EVIDENCE_GAPS=['historical_publication_unverified','historical_universe_unknown'];
const DDL=[
 `CREATE TABLE IF NOT EXISTS final_evaluation_reports (experiment_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL, PRIMARY KEY(experiment_id,version))`,
 `CREATE TRIGGER IF NOT EXISTS final_evaluation_reports_no_update BEFORE UPDATE ON final_evaluation_reports BEGIN SELECT RAISE(ABORT,'immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS final_evaluation_reports_no_delete BEFORE DELETE ON final_evaluation_reports BEGIN SELECT RAISE(ABORT,'immutable'); END`,
];

function storedReport(db:Db,experimentId:string,version:number) {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='final_evaluation_reports'").get()) return null;
 const row=db.prepare('SELECT content,content_sha256 FROM final_evaluation_reports WHERE experiment_id=? AND version=?').get(experimentId,version) as {content:string;content_sha256:string}|undefined;
 if(!row) return null;
 if(sha256(row.content)!==row.content_sha256) throw new Error('final evaluation report integrity failure');
 return JSON.parse(row.content);
}

/** Reads a stored final report without ever running one; null when none exists for that version. */
export function getFinalEvaluation(db:Db,experimentId:string,version:number) {
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(experimentId) || !Number.isSafeInteger(version) || version<1) throw new DomainError('INVALID_INPUT','Final evaluation request rejected',[{ruleId:'research.evaluation_request'}]);
 return storedReport(db,experimentId,version);
}

/**
 * Opens the registered evaluation window exactly once per experiment version and stores an
 * immutable report; later calls return that report. Blocked requests do not consume the run.
 */
export function runFinalEvaluation(db:Db,registry:Registry,raw:unknown,now:()=>Date) {
 const request=parseReplayInput(requestSchema,raw);
 const existing=storedReport(db,request.experimentId,request.version);
 if(existing) return existing;
 const loaded=loadRegisteredExperiment(db,registry,request);
 const {registration,inspection}=loaded, {replay,gates}=registration;
 const base={schemaVersion:1 as const,experimentId:request.experimentId,version:request.version,registrationSha256:registration.contentSha256,history:{reference:inspection.reference,sha256:inspection.sha256},executionAuthorized:false as const};
 if(!replay || !gates?.sensitivity || !gates.costStressMultipliers || gates.costStressMustStayPositiveAt===undefined || gates.requireBeatHold===undefined)
  return {...base,outcome:'blocked' as const,reasonCode:'rules_incomplete' as const,validation:null,sensitivity:null,evaluation:null,gatesMet:false,status:'insufficient' as const,evidenceGaps:[],sampleNotes:[]};
 const validation=judgeExplorationAndValidation(loaded,gates);
 const sensitivity=assessSensitivity(loaded,replay,gates.sensitivity);
 const window=replayWindow(loaded,'evaluation'), robustness=stressAndBaselines(loaded,'evaluation',replay,gates.costStressMultipliers);
 const failed:string[]=[], insufficient:string[]=[], net=window.metrics?.netUsdt ?? null;
 const stressed=robustness.costStress.find(s=>s.multiplier===gates.costStressMustStayPositiveAt)!.metrics?.netUsdt ?? null;
 if(!window.metrics) insufficient.push('evaluation_missing_evidence');
 else if(window.metrics.realizedTrades===0) insufficient.push('evaluation_no_realized_trades');
 if(net!==null) {
  if(gates.requirePositiveNet && !new Decimal(net).gt(0)) failed.push('evaluation_net_not_positive');
  if(gates.requireBeatHold && robustness.hold && !new Decimal(net).gt(robustness.hold.netUsdt)) failed.push('evaluation_does_not_beat_hold');
  if(stressed!==null && !new Decimal(stressed).gt(0)) failed.push('evaluation_not_positive_under_cost_stress');
 }
 const evaluationGate=failed.length ? 'failed' as const : insufficient.length ? 'insufficient' as const : 'met' as const;
 const gateStates=[validation.validationGate,sensitivity.sensitivityGate,evaluationGate];
 const gatesMet=gateStates.every(g=>g==='met');
 const evidenceGaps=inspection.unknowns.filter(u=>EVIDENCE_GAPS.includes(u)).sort();
 const status=gateStates.includes('failed') ? 'failed' as const : gatesMet && !evidenceGaps.length ? 'passed' as const : 'insufficient' as const;
 const report={...base,createdAt:now().toISOString(),outcome:'evaluated' as const,reasonCode:null,validation,sensitivity,
  evaluation:{...window,...robustness,evaluationGate,reasons:[...failed,...insufficient]},
  gatesMet,status,evidenceGaps,scope:'historical_replay_only',
  // One position at a time per instrument, but trades share one market and regime.
  sampleNotes:['trades_are_not_independent_samples','passed_never_implies_demo_or_live_readiness']};
 const content=canonicalJson(report);
 return inTransaction(db,()=>{
  for(const sql of DDL) db.exec(sql);
  // Another process may have finished first; its stored report wins.
  const raced=storedReport(db,request.experimentId,request.version);
  if(raced) return raced;
  db.prepare('INSERT INTO final_evaluation_reports VALUES(?,?,?,?)').run(request.experimentId,request.version,content,sha256(content));
  return JSON.parse(content);
 });
}
