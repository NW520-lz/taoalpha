import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replayRegisteredExperiment} from '../../src/research/registered-replay.ts';
import {assessParameterSensitivity} from '../../src/research/sensitivity.ts';
import {judgeValidation} from '../../src/research/validation-judgement.ts';
import {expectDomainError} from '../helpers/assertions.ts';
import {runFinalEvaluation} from '../../src/research/final-evaluation.ts';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {aggregateUniverse} from '../../src/research/universe.ts';
import {H,expected,fakeHistoryClient,now,setup} from '../helpers/experiment-fixtures.ts';

// Oscillation around 100. Grid centred on each window's first open, range 10% (lines 90/100/110), stop 20% below.
// Exploration [0,6): three round trips 90 -> 100; validation [6,9): one; evaluation [9,12): one.
export const gridBars=[[100,101,89,95],[95,101,94,99],[99,100,89,92],[92,101,91,98],[98,99,89,93],[93,101,92,96],[100,101,89,92],[92,101,91,99],[99,100,95,97],[100,101,89,91],[91,101,90,99],[99,100,98,99]];
export const gridReplay={market:{product:'spot',quote:'USDT',baseQuantity:'1'},rule:{kind:'grid_spot',rangeFraction:'0.1',gridCount:2,spacing:'arithmetic',stopFraction:'0.2'},cost:{entryFeePpm:1000,exitFeePpm:1000,entryImpactPpm:0,exitImpactPpm:0,funding:'not_applicable'}};

test('a grid rule registers like a trend rule and its windows replay with the grid engine',async()=>{
 const {db,registry,input}=await setup([],gridBars);try {
  const record=registry.register({...input,replay:gridReplay});
  assert.deepEqual([record.schemaVersion,record.replay],[3,gridReplay]);
  const window=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  // Each round trip: gross 10, fees (90 + 100) x 0.1% = 0.19.
  assert.deepEqual([window.metrics?.realizedTrades,window.metrics?.netUsdt,window.metrics?.feesUsdt],[3,'29.43','0.57']);
  // Every close-marked equity value is above the previous peak, so there is no drawdown.
  assert.equal(window.maxEquityDrawdownUsdt,'0');
  expectDomainError(()=>registry.register({...input,version:2,attemptId:'attempt:trend:2',replay:{...gridReplay,rule:{...gridReplay.rule,stopFraction:'0.05'}}}),'INVALID_INPUT');
 }finally{db.close()}
});

const gridGates={minRealizedTrades:1,maxValidationDecay:'0.4',normalizationDays:1,requirePositiveNet:true,costStressMultipliers:[1,2],costStressMustStayPositiveAt:2,requireBeatHold:false,maxEquityDrawdownUsdt:'5',
 sensitivity:{neighbourhoods:{gridCount:[2,3],rangeFraction:['0.1','0.15'],stopFraction:['0.2','0.25']},maxAdjacentChange:'0.5',requireAllPositive:true}};

test('grid gates use grid neighbourhoods and an equity drawdown limit; trend-only settings are refused',async()=>{
 const {db,registry,input}=await setup([],gridBars);try {
  const trendNeighbourhood={...gridGates,sensitivity:{...gridGates.sensitivity,neighbourhoods:{atrPeriod:[2,3]}}};
  const stopGrid={...gridGates,sensitivity:{...gridGates.sensitivity,stopGrid:{initialStopAtr:['1'],trailingStopAtr:['1']}}};
  for(const gates of [trendNeighbourhood,stopGrid]) expectDomainError(()=>registry.register({...input,replay:gridReplay,gates}),'INVALID_INPUT');
  // The equity drawdown limit needs an engine that reports it.
  expectDomainError(()=>registry.register({...input,gates:{...gridGates,sensitivity:undefined}}),'INVALID_INPUT');
  registry.register({...input,replay:gridReplay,gates:gridGates});
  const request={experimentId:'experiment:trend',version:1,expected};
  // Per hour: exploration 29.43 / 6, validation 9.81 / 3, so decay is one third.
  const judged=judgeValidation(db,registry,request);
  assert.deepEqual([judged.decay,judged.validationGate,judged.exploration?.maxEquityDrawdownUsdt],['0.3333333333','met','0']);
  const sensitivity=assessParameterSensitivity(db,registry,request);
  assert.deepEqual(sensitivity.parameters?.map(p=>p.parameter),['gridCount','rangeFraction','stopFraction']);
  // A 15% range puts the lowest line at 85, below every exploration low, so that point has no trades.
  assert.ok((sensitivity.reasons as string[]).includes('rangeFraction_point_without_trades'));
  assert.deepEqual(sensitivity.parameters?.[2]?.points.map(p=>p.netUsdt),['29.43','29.43']);
 }finally{db.close()}
});

test('a close-marked equity drawdown above the registered limit fails the window',async()=>{
 // Bar 1 now closes at 86 while the slot bought at 90 is held: equity falls from 4.815 to -4.176.
 const bars=[[100,101,89,95],[95,96,85,86],[86,101,85,99],...gridBars.slice(3)];
 const {db,registry,input}=await setup([],bars);try {
  registry.register({...input,replay:gridReplay,gates:gridGates});
  const judged=judgeValidation(db,registry,{experimentId:'experiment:trend',version:1,expected});
  assert.equal(judged.exploration?.maxEquityDrawdownUsdt,'8.991');
  assert.deepEqual([judged.validationGate,judged.reasons],['failed',['exploration_equity_drawdown_above_limit']]);
 }finally{db.close()}
});

test('the run-once final evaluation judges a grid, including its equity drawdown limit',async()=>{
 // The evaluation window [9,12) repeats the drawdown shape: equity falls from 4.815 to -4.176.
 const bars=[...gridBars.slice(0,9),[100,101,89,95],[95,96,85,86],[86,101,85,99]];
 const {db,registry,input}=await setup([],bars);try {
  registry.register({...input,replay:gridReplay,gates:{...gridGates,sensitivity:{...gridGates.sensitivity,neighbourhoods:{stopFraction:['0.2','0.25']}}}});
  const report=runFinalEvaluation(db,registry,{experimentId:'experiment:trend',version:1,expected},now);
  assert.deepEqual([report.validation?.validationGate,report.sensitivity?.sensitivityGate],['met','met']);
  const evaluation=report.evaluation as {maxEquityDrawdownUsdt:string;evaluationGate:string;reasons:string[]};
  assert.deepEqual([evaluation.maxEquityDrawdownUsdt,evaluation.evaluationGate,evaluation.reasons,report.status],['8.991','failed',['evaluation_equity_drawdown_above_limit'],'failed']);
  assert.deepEqual(runFinalEvaluation(db,registry,{experimentId:'experiment:trend',version:1,expected},now),report);
 }finally{db.close()}
});

test('a grid universe replays each instrument with its own centred grid and reports each equity drawdown',async()=>{
 const {db,registry,input}=await setup([],gridBars);try {
  // ETH follows the drawdown shape: one round trip fewer (19.62) and equity drawdown 8.991.
  const ethBars=[[100,101,89,95],[95,96,85,86],[86,101,85,99],...gridBars.slice(3)];
  const manifest=await collectHistory(fakeHistoryClient(ethBars),{instId:'ETH-USDT',product:'spot',resolution:'1H',start:0,end:12*H,asOf:12*H,limit:100,maxPages:2,capturedAt:'1970-01-02T00:00:00.000Z'});
  const id=saveHistory(db,manifest);
  const eth={reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:{...expected,instId:'ETH-USDT'}};
  registry.register({...input,replay:gridReplay,universe:{instruments:[{group:'majors',data:input.data},{group:'majors',data:eth}]},gates:{minRealizedTrades:1,maxValidationDecay:'0.4',normalizationDays:1,requirePositiveNet:true,multiInstrument:{minPositiveGroupShare:'1',minPositiveRegimes:0}}});
  const result=aggregateUniverse(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  assert.deepEqual(result.instruments!.map(i=>[i.instId,i.metrics!.netUsdt,i.maxEquityDrawdownUsdt]),[['BTC-USDT','29.43','0'],['ETH-USDT','19.62','8.991']]);
  assert.deepEqual([result.total!.realizedTrades,result.total!.netUsdt,result.universeGate],[5,'49.05','met']);
 }finally{db.close()}
});
