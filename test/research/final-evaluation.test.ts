import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runFinalEvaluation} from '../../src/research/final-evaluation.ts';
import {ohlc,expected,setup,windowsAt,now} from '../helpers/experiment-fixtures.ts';

// Validation (bars 6-11) and evaluation (bars 12-17) share one hand-worked trade: entry 116, exit 121.5, net 9.575.
const trend=[[111,112,110,111],[111,112,110,111],[111,115,111,115],[116,121,115,120],[120,126,119,125],[125,127,120,121]];
const bars=[...ohlc.slice(0,6),...trend,...trend];
// Exploration trailing 1.6 exits at 110.2: net 9.1088, 6.16% from 9.707.
const gates={minRealizedTrades:1,maxValidationDecay:'0.4',normalizationDays:1,requirePositiveNet:true,costStressMultipliers:[1,2],costStressMustStayPositiveAt:2,requireBeatHold:false,sensitivity:{neighbourhoods:{trailingStopAtr:['1.5','1.6']},maxAdjacentChange:'0.5',requireAllPositive:true}};
const request={experimentId:'experiment:trend',version:1,expected};

test('when every frozen gate is met the report says so but stays insufficient while historical evidence is unknown',async()=>{
 const {db,registry,input}=await setup([],bars);try {
  registry.register({...input,windows:windowsAt(6,12,18),gates});
  const report=runFinalEvaluation(db,registry,request,now);
  assert.deepEqual([report.validation!.validationGate,report.sensitivity!.sensitivityGate,report.evaluation!.evaluationGate],['met','met','met']);
  assert.equal(report.evaluation!.metrics!.netUsdt,'9.575');
  // Hold on the evaluation window: 111 -> 121, net 20 - 0.464 - 0.928.
  assert.equal(report.evaluation!.hold!.netUsdt,'18.608');
  assert.equal(report.gatesMet,true);
  assert.equal(report.status,'insufficient');
  assert.deepEqual(report.evidenceGaps,['historical_publication_unverified','historical_universe_unknown']);
  assert.ok(report.sampleNotes.includes('trades_are_not_independent_samples'));
  assert.equal(report.executionAuthorized,false);
 }finally{db.close()}
});

test('the evaluation window runs once: a repeat returns the stored report and a failure stays failed',async()=>{
 const {db,registry,input}=await setup([],bars);try {
  registry.register({...input,windows:windowsAt(6,12,18),gates:{...gates,requireBeatHold:true}});
  const first=runFinalEvaluation(db,registry,request,now);
  assert.deepEqual([first.status,first.evaluation!.reasons],['failed',['evaluation_does_not_beat_hold']]);
  const later=()=>new Date('2027-01-01T00:00:00.000Z');
  assert.deepEqual(runFinalEvaluation(db,registry,request,later),first);
  assert.equal(db.prepare('SELECT count(*) n FROM final_evaluation_reports').get()!.n,1);
  assert.throws(()=>db.prepare("UPDATE final_evaluation_reports SET content='{}'").run());
 }finally{db.close()}
});

test('incomplete gates are blocked without consuming the single evaluation run',async()=>{
 const {db,registry,input}=await setup([],bars);try {
  const {sensitivity:_,...noSensitivity}=gates;
  registry.register({...input,windows:windowsAt(6,12,18),gates:noSensitivity});
  const blocked=runFinalEvaluation(db,registry,request,now);
  assert.deepEqual([blocked.outcome,blocked.reasonCode,blocked.evaluation],['blocked','rules_incomplete',null]);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='final_evaluation_reports'").get()!.n===0 || db.prepare('SELECT count(*) n FROM final_evaluation_reports').get()!.n===0,true);
 }finally{db.close()}
});
