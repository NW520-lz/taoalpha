import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../../src/store/db.ts';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {createExperimentRegistry} from '../../src/research/experiment-registry.ts';
import {replayRegisteredExperiment} from '../../src/research/registered-replay.ts';
import type {PublicClient} from '../../src/okx/public-client.ts';
import {expectDomainError} from '../helpers/assertions.ts';

const H=3600000;
const now=()=>new Date('2026-01-01T00:00:00.000Z');
// Same hand-worked trend as trend-replay.test.ts (bars 0-5), then a later breakout at bar 7.
const ohlc=[[100,101,99,100],[100,101,99,100],[100,104,100,104],[105,110,104,109],[109,115,108,114],[114,116,110,111],[111,112,110,111],[111,118,111,117],[118,119,117,118],[118,119,117,118],[118,119,117,118],[118,119,117,118]];
const expected={site:'global',instId:'BTC-USDT',product:'spot',resolution:'1H'} as const;
const replay={market:{product:'spot',quote:'USDT',baseQuantity:'2'},rule:{kind:'breakout_atr_trailing',breakoutLookback:2,atrPeriod:2,initialStopAtr:'2',trailingStopAtr:'1.5'},cost:{entryFeePpm:1000,exitFeePpm:1000,entryImpactPpm:2000,exitImpactPpm:2000,funding:'not_applicable'}};

async function setup(omit:number[]=[],bars:number[][]=ohlc) {
 const rows=bars.map((p,i)=>[String(i*H),...p.map(String),'1','100','100','1']).filter((_,i)=>!omit.includes(i)).reverse();
 const pages=[rows,[]];
 const client:PublicClient={site:'global',async get<T>(path:string,query:Record<string,string>){
  const data=(pages.shift() ?? []) as T[]; const endpoint=path+'?'+new URLSearchParams(query);
  return {ok:true as const,endpoint,rows:data,raw:{endpoint,receivedAt:'1970-01-02T00:00:00.000Z',status:200,body:JSON.stringify({code:'0',data})}};
 }};
 const db=openDb(':memory:'); const registry=createExperimentRegistry(db,now);
 const manifest=await collectHistory(client,{instId:'BTC-USDT',product:'spot',resolution:'1H',start:0,end:12*H,asOf:12*H,limit:100,maxPages:2,capturedAt:'1970-01-02T00:00:00.000Z'});
 const id=saveHistory(db,manifest);
 const input={experimentId:'experiment:trend',version:1,attemptId:'attempt:trend:1',strategy:{id:'strategy:trend',version:1,entryRules:'close above prior highs',exitRules:'ATR initial and trailing stop',invalidationRules:'stop'},data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:expected},code:{reference:'code:trend',sha256:'b'.repeat(64),version:'v1'},costs:{fees:'10 bps per side',spread:'in impact',slippage:'20 bps per side',funding:'not applicable',execution:'next open'},windows:{exploration:{start:'1970-01-01T00:00:00Z',end:'1970-01-01T06:00:00Z'},validation:{start:'1970-01-01T06:00:00Z',end:'1970-01-01T09:00:00Z'},evaluation:{start:'1970-01-01T09:00:00Z',end:'1970-01-01T12:00:00Z'}},evaluation:{metrics:'net',thresholds:'positive',baseline:'hold',method:'replay'},replay};
 return {db,registry,manifest,input};
}

test('structured replay parameters are frozen into the registration and cannot change within a version',async()=>{
 const {db,registry,input}=await setup();try {
  const record=registry.register(input);
  assert.equal(record.schemaVersion,3);
  assert.deepEqual(record.replay,replay);
  assert.deepEqual(registry.get('experiment:trend',1),record);
  assert.deepEqual(registry.register(input),record);
  expectDomainError(()=>registry.register({...input,replay:{...replay,rule:{...replay.rule,trailingStopAtr:'2'}}}),'IDEMPOTENCY_CONFLICT');
 }finally{db.close()}
});

test('replay parameters must be valid and match the frozen data scope',async()=>{
 const {db,registry,input}=await setup();try {
  const swapScope={...expected,instId:'BTC-USDT-SWAP',product:'usdt_perpetual'};
  expectDomainError(()=>registry.register({...input,data:{...input.data,scope:swapScope}}),'INVALID_INPUT');
  expectDomainError(()=>registry.register({...input,replay:{...replay,rule:{...replay.rule,trailingStopAtr:'0'}}}),'INVALID_INPUT');
  expectDomainError(()=>registry.register({...input,replay:{...replay,cost:{...replay.cost,funding:'unknown'}}}),'INVALID_INPUT');
  assert.equal(registry.get('experiment:trend',1),null);
 }finally{db.close()}
});

test('the exploration window replays only its own candles with the registered parameters',async()=>{
 const {db,registry,input}=await setup();try {
  const record=registry.register(input);
  const result=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  assert.equal(result.outcome,'replayed');
  assert.equal(result.registrationSha256,record.contentSha256);
  assert.equal(result.scopeBinding,'registration_bound');
  assert.deepEqual(result.range,{start:0,end:6*H});
  assert.equal(result.segments.length,1);
  const segment=result.segments[0]!;
  assert.deepEqual([segment.firstOpenMs,segment.lastCloseMs,segment.candles,segment.endsAt],[0,6*H,6,'window_end']);
  // Bars 6-8 belong to the validation window, so the bar-7 breakout must not appear here.
  assert.deepEqual(segment.result.hypotheticalTrades.map(t=>[t.signalIndex,t.entryIndex,t.exitIndex,t.exitReason,t.netUsdt]),[[2,3,5,'stop','9.707']]);
  assert.equal(result.status,'insufficient');assert.equal(result.executionAuthorized,false);
 }finally{db.close()}
});

test('a registration with only prose rules is blocked as rules_incomplete instead of being guessed',async()=>{
 const {db,registry,input}=await setup();try {
  const {replay:_,...proseOnly}=input;
  assert.equal(registry.register(proseOnly).schemaVersion,2);
  const result=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  assert.equal(result.outcome,'blocked');
  assert.equal(result.reasonCode,'rules_incomplete');
  assert.deepEqual(result.segments,[]);
  assert.equal(result.executionAuthorized,false);
 }finally{db.close()}
});

test('the final evaluation window stays sealed until a run-once evaluation report exists',async()=>{
 const {db,registry,input}=await setup();try {
  registry.register(input);
  const validation=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'validation'});
  assert.deepEqual(validation.range,{start:6*H,end:9*H});
  assert.deepEqual(validation.segments.map(s=>[s.firstOpenMs,s.candles]),[[6*H,3]]);
  expectDomainError(()=>replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'evaluation'}),'UNSUPPORTED_CAPABILITY',{ruleId:'experiment.evaluation_window_sealed'});
 }finally{db.close()}
});

test('a missing candle splits the window and a position open at the gap is flagged, not trusted',async()=>{
 const {db,registry,input,manifest}=await setup([4]);try {
  assert.equal(manifest.candleCoverage,'partial');
  registry.register(input);
  const result=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  assert.deepEqual(result.segments.map(s=>[s.firstOpenMs,s.candles,s.startsAt,s.endsAt,s.openAtGap]),[[0,4,'window_start','data_gap',true],[5*H,1,'data_gap','window_end',false]]);
  // Entered at bar 3; the bar-4 gap ends the segment, so the trade is only a mark at bar 3's close.
  assert.deepEqual(result.segments[0]!.result.hypotheticalTrades.map(t=>[t.entryIndex,t.exitReason,t.exitPrice]),[[3,'end_of_data','109']]);
 }finally{db.close()}
});

test('mismatched scope, unknown experiments and hostile requests are rejected without writing anything',async()=>{
 const {db,registry,input}=await setup();try {
  registry.register(input);
  const before=db.prepare('SELECT total_changes() n').get()!.n;
  const request={experimentId:'experiment:trend',version:1,expected,window:'exploration'};
  replayRegisteredExperiment(db,registry,request);
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n,before);
  expectDomainError(()=>replayRegisteredExperiment(db,registry,{...request,expected:{...expected,instId:'ETH-USDT'}}),'INVALID_INPUT');
  expectDomainError(()=>replayRegisteredExperiment(db,registry,{...request,version:2}),'INVALID_INPUT');
  expectDomainError(()=>replayRegisteredExperiment(db,registry,{...request,window:'all'}),'INVALID_INPUT');
  const hostile=Object.defineProperty({...request},'window',{enumerable:true,get(){throw Error('private-sentinel')}});
  assert.throws(()=>replayRegisteredExperiment(db,registry,hostile),(error:unknown)=>{assert.doesNotMatch(String(error)+JSON.stringify(error),/sentinel/);return true});
 }finally{db.close()}
});

test('a window reports evaluation metrics computed from its replayed trades',async()=>{
 const {db,registry,input}=await setup();try {
  registry.register(input);
  const {metrics}=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  // One hand-worked trade: gross 11, fees 0.431, impact 0.862, net 9.707; costs/gross = 1.293/11.
  assert.deepEqual(metrics,{realizedTrades:1,markedAtWindowEnd:{trades:0,netUsdt:null},unresolvedAtGap:0,grossUsdt:'11',feesUsdt:'0.431',impactUsdt:'0.862',costUsdt:'1.293',netUsdt:'9.707',costToGrossRatio:'0.1175454545',wins:1,winRate:'1',averageWinUsdt:'9.707',averageLossUsdt:null,maxDrawdownUsdt:'0',tradeNetsUsdt:['9.707']});
 }finally{db.close()}
});

test('a stopped-out loss after a winner drives drawdown, averages and win rate',async()=>{
 // Bar 9 trades down to 110: the bar-7 breakout entered at 118 is stopped at 119-6.75=112.25.
 const bars=ohlc.map((b,i)=>i===9?[118,119,110,111]:i>9?[111,112,110,111]:b);
 const {db,registry,input}=await setup([],bars);try {
  const windows={exploration:{start:'1970-01-01T00:00:00Z',end:'1970-01-01T10:00:00Z'},validation:{start:'1970-01-01T10:00:00Z',end:'1970-01-01T11:00:00Z'},evaluation:{start:'1970-01-01T11:00:00Z',end:'1970-01-01T12:00:00Z'}};
  registry.register({...input,windows});
  const {metrics}=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  // Loss: gross 2*(112.25-118)=-11.5, fees 0.236+0.2245, impact 0.472+0.449, net -12.8815.
  assert.deepEqual(metrics,{realizedTrades:2,markedAtWindowEnd:{trades:0,netUsdt:null},unresolvedAtGap:0,grossUsdt:'-0.5',feesUsdt:'0.8915',impactUsdt:'1.783',costUsdt:'2.6745',netUsdt:'-3.1745',costToGrossRatio:null,wins:1,winRate:'0.5',averageWinUsdt:'9.707',averageLossUsdt:'-12.8815',maxDrawdownUsdt:'12.8815',tradeNetsUsdt:['9.707','-12.8815']});
 }finally{db.close()}
});

test('a position still open at the window end is reported as a mark, not a realized result',async()=>{
 const {db,registry,input}=await setup();try {
  const windows={exploration:{start:'1970-01-01T00:00:00Z',end:'1970-01-01T09:00:00Z'},validation:{start:'1970-01-01T09:00:00Z',end:'1970-01-01T10:00:00Z'},evaluation:{start:'1970-01-01T10:00:00Z',end:'1970-01-01T12:00:00Z'}};
  registry.register({...input,windows});
  const {metrics}=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  // The bar-8 entry at 118 is only marked at the window-end close 118: net -1.416 after costs.
  assert.equal(metrics!.realizedTrades,1);assert.equal(metrics!.netUsdt,'9.707');
  assert.deepEqual(metrics!.markedAtWindowEnd,{trades:1,netUsdt:'-1.416'});
 }finally{db.close()}
});

test('a position open at a data gap is counted but never enters the metrics',async()=>{
 const {db,registry,input}=await setup([4]);try {
  registry.register(input);
  const {metrics}=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  // No realized trade: amounts are not applicable rather than a zero result.
  assert.deepEqual(metrics,{realizedTrades:0,markedAtWindowEnd:{trades:0,netUsdt:null},unresolvedAtGap:1,grossUsdt:null,feesUsdt:null,impactUsdt:null,costUsdt:null,netUsdt:null,costToGrossRatio:null,wins:0,winRate:null,averageWinUsdt:null,averageLossUsdt:null,maxDrawdownUsdt:null,tradeNetsUsdt:[]});
 }finally{db.close()}
});

test('a blocked registration has no metrics rather than zero results',async()=>{
 const {db,registry,input}=await setup();try {
  const {replay:_,...proseOnly}=input; registry.register(proseOnly);
  assert.equal(replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'}).metrics,null);
 }finally{db.close()}
});

test('a window without any candles is blocked as missing evidence, and unaligned bounds are not called gaps',async()=>{
 const {db,registry,input}=await setup([0,1,2,3,4,5]);try {
  registry.register(input);
  const empty=replayRegisteredExperiment(db,registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  assert.deepEqual([empty.outcome,empty.reasonCode,empty.metrics],['blocked','missing_required_evidence',null]);
 }finally{db.close()}
 const second=await setup();try {
  // Window 00:30-06:30: bars 1-5 are the only whole bars inside, so neither bound is a data gap.
  const windows={exploration:{start:'1970-01-01T00:30:00Z',end:'1970-01-01T06:30:00Z'},validation:{start:'1970-01-01T06:30:00Z',end:'1970-01-01T09:00:00Z'},evaluation:{start:'1970-01-01T09:00:00Z',end:'1970-01-01T12:00:00Z'}};
  second.registry.register({...second.input,windows});
  const result=replayRegisteredExperiment(second.db,second.registry,{experimentId:'experiment:trend',version:1,expected,window:'exploration'});
  assert.deepEqual(result.segments.map(s=>[s.firstOpenMs,s.candles,s.startsAt,s.endsAt]),[[H,5,'window_start','window_end']]);
 }finally{second.db.close()}
});
