import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {compareAgentVeto} from '../../src/research/agent-veto.ts';
import {simulateRelativeStrength} from '../../src/research/relative-strength.ts';
import {loadRegisteredExperiment} from '../../src/research/registered-replay.ts';
import {completeTask,nextTasks,startResearch} from '../../src/research/research-service.ts';
import {expectDomainError} from '../helpers/assertions.ts';
import {H,ohlc,expected,replay,setup,fakeHistoryClient} from '../helpers/experiment-fixtures.ts';
import {NOW} from '../helpers/market-fixtures.ts';
import {adversaryReport,fundamentalsReport,marketStructureReport,quantReport,seedBundle,synthesisReport} from '../helpers/research-fixtures.ts';
import type {Db} from '../../src/store/db.ts';

// Same universe as relative-strength.test.ts: A wins the single slot at bar 2 over B; C fails the turnover filter.
const pad=(bars:number[][],last:number[])=>[...bars,...Array.from({length:12-bars.length},()=>last)];
const btc=pad([[100,101,99,100],[100,101,99,100],[100,102,100,101]],[101,102,100,101]);
const a=pad([[...ohlc[0]!,100],[...ohlc[1]!,100],[...ohlc[2]!,300],...ohlc.slice(3,6)],[111,112,110,111]);
const b=pad([[100,101,99,100,100],[100,101,99,100,100],[100,103,100,103,300]],[102,103,101,102]);
const selection={strengthLookback:2,volumeLookback:2,volumeMultiplier:'2',maxPositions:1};
const request={experimentId:'experiment:trend',version:1,expected,window:'exploration'};
const now=()=>NOW;

async function member(db:Db,instId:string,bars:number[][]) {
 const manifest=await collectHistory(fakeHistoryClient(bars),{instId,product:'spot',resolution:'1H',start:0,end:12*H,asOf:12*H,limit:100,maxPages:2,capturedAt:'1970-01-02T00:00:00.000Z'});
 const id=saveHistory(db,manifest);
 return {group:'alts',data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:{...expected,instId}}};
}
async function finishedRun(db:Db) {
 const scan=await seedBundle(db);
 const ref=scan.candidates.find(c=>c.instId==='GOOD-USDT')!.snapshotEvidenceId;
 const run=startResearch(db,{bundleId:scan.bundleId,agentMode:'serial_degraded'},now);
 const submit=(role:string,report:unknown)=>completeTask(db,{assignmentId:nextTasks(db,run.runId).find(t=>t.role===role)!.assignmentId,outcome:{kind:'report',report}},now);
 submit('market_structure',marketStructureReport(ref));submit('fundamentals_events',fundamentalsReport(ref));submit('quant_validation',quantReport(ref));
 submit('adversary',adversaryReport(ref));submit('synthesis',synthesisReport(ref,{decision:'skip'}));
 return run.runId;
}

test('a veto from research run after the signal is rejected, so both arms stay identical',async()=>{
 const {db,registry,input}=await setup([],btc);try {
  const universe={instruments:[await member(db,'A-USDT',a),await member(db,'B-USDT',b)]};
  const finished=await finishedRun(db);
  const unfinished=startResearch(db,{bundleId:(await seedBundle(db)).bundleId,agentMode:'parallel_independent'},now).runId;
  const agentVetoes=[{instId:'A-USDT',signalOpenMs:2*H,researchRunId:finished},{instId:'B-USDT',signalOpenMs:2*H,researchRunId:unfinished},{instId:'A-USDT',signalOpenMs:9*H,researchRunId:'run_00000000-0000-4000-8000-000000000000'}];
  registry.register({...input,universe,replay:{...replay,selection},agentVetoes});
  const result=compareAgentVeto(db,registry,request);
  // Research evidence frozen in 2026 cannot have been known at a 1970 signal.
  assert.deepEqual(result.rejectedVetoes!.map(v=>[v.instId,v.reason]),[['A-USDT','evidence_after_signal'],['B-USDT','research_unfinished'],['A-USDT','research_run_missing']]);
  assert.deepEqual(result.appliedVetoes,[]);
  assert.deepEqual([result.rulesOnly!.netUsdt,result.withVeto!.netUsdt,result.netDifferenceUsdt],['9.707','9.707','0']);
  assert.deepEqual(result.researchRuns!.map(r=>[r.agentMode,r.hostVerified]),[['serial_degraded',false],['parallel_independent',false]]);
  assert.ok(result.unknowns.includes('agent_call_cost_unrecorded'));
  expectDomainError(()=>compareAgentVeto(db,registry,{...request,window:'evaluation'}),'UNSUPPORTED_CAPABILITY');
 }finally{db.close()}
});

test('an applied veto removes that candidate before ranking, so the next one takes the slot',async()=>{
 const {db,registry,input}=await setup([],btc);try {
  registry.register({...input,universe:{instruments:[await member(db,'A-USDT',a),await member(db,'B-USDT',b)]},replay:{...replay,selection}});
  const result=simulateRelativeStrength(db,loadRegisteredExperiment(db,registry,request),'exploration',new Set(['A-USDT@'+2*H]));
  // A breaks out again at bars 3 (109 > 104) and 4 (114 > 110), but turnover 100 is below 2x its prior mean 200.
  assert.deepEqual(result.skips,[{instId:'A-USDT',signalOpenMs:2*H,reason:'agent_veto'},{instId:'A-USDT',signalOpenMs:3*H,reason:'turnover_not_expanded'},{instId:'A-USDT',signalOpenMs:4*H,reason:'turnover_not_expanded'}]);
  assert.deepEqual(result.trades!.map(t=>[t.instId,t.entryOpenMs]),[['B-USDT',3*H]]);
 }finally{db.close()}
});
