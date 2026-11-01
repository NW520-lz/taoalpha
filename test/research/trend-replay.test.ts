import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replayTrendCandles} from '../../src/research/trend-replay.ts';
import {collectHistory} from '../../src/market/history.ts';
import type {PublicClient} from '../../src/okx/public-client.ts';

const H=3600000;
const bar=(i:number,o:number,h:number,l:number,c:number)=>({ts:i*H,closeTime:(i+1)*H,open:String(o),high:String(h),low:String(l),close:String(c)});
// Hand-worked example: breakout at bar 2 (close 104 > prior highs 101), ATR(2)=(2+4)/2=3,
// entry 105 at bar 3 open, initial stop 105-2*3=99, trailing distance 1.5*3=4.5.
const trend=[bar(0,100,101,99,100),bar(1,100,101,99,100),bar(2,100,104,100,104),bar(3,105,110,104,109),bar(4,109,115,108,114),bar(5,114,116,110,111)];
const base={schemaVersion:1,market:{product:'spot',quote:'USDT',baseQuantity:'2'},resolutionMs:H,rule:{kind:'breakout_atr_trailing',breakoutLookback:2,atrPeriod:2,initialStopAtr:'2',trailingStopAtr:'1.5'},cost:{entryFeePpm:1000,exitFeePpm:1000,entryImpactPpm:2000,exitImpactPpm:2000,funding:'not_applicable'},candles:trend};

test('a breakout rides the trailing stop and exits at the stop level with costs counted once per side',()=>{
 const result=replayTrendCandles(base);
 assert.equal(result.hypotheticalTrades.length,1);
 const trade=result.hypotheticalTrades[0]!;
 assert.deepEqual([trade.signalIndex,trade.entryIndex,trade.exitIndex,trade.exitReason],[2,3,5,'stop']);
 assert.deepEqual([trade.atrAtSignal,trade.initialStopPrice,trade.trailingDistance],['3','99','4.5']);
 // Stop at bar 5 = highest prior high 115 - 4.5 = 110.5; bar 5 low 110 touches it.
 assert.deepEqual([trade.entryPrice,trade.exitPrice],['105','110.5']);
 assert.equal(trade.grossUsdt,'11');
 assert.equal(trade.feesUsdt,'0.431');
 assert.equal(trade.impactUsdt,'0.862');
 assert.equal(trade.netUsdt,'9.707');
});

test('a same-bar high cannot tighten that bar\'s stop, and a gap below the stop fills at the open',()=>{
 // Bar 4 spikes to 120 then trades down to 108: its own high is unknown-ordered, so the
 // stop for bar 4 stays at 110-4.5=105.5. Bar 5 then opens at 114, below 120-4.5=115.5.
 const candles=[...trend.slice(0,4),bar(4,109,120,108,114),bar(5,114,116,110,111)];
 const trade=replayTrendCandles({...base,candles}).hypotheticalTrades[0]!;
 assert.deepEqual([trade.exitIndex,trade.exitReason,trade.exitPrice],[5,'gap_through_stop','114']);
});

test('a position still open when data ends is marked at the last close with exit costs',()=>{
 const trade=replayTrendCandles({...base,candles:trend.slice(0,5)}).hypotheticalTrades[0]!;
 assert.deepEqual([trade.exitIndex,trade.exitReason,trade.exitPrice],[4,'end_of_data','114']);
 // 2*(114-105)=18; fees 0.21+0.228; impact 0.42+0.456.
 assert.deepEqual([trade.grossUsdt,trade.feesUsdt,trade.impactUsdt,trade.netUsdt],['18','0.438','0.876','16.686']);
});

test('a breakout on the final candle is reported as skipped rather than silently ignored',()=>{
 const result=replayTrendCandles({...base,candles:trend.slice(0,3)});
 assert.deepEqual(result.hypotheticalTrades,[]);
 assert.deepEqual(result.skips,[{signalIndex:2,reason:'no_entry_candle'}]);
 assert.deepEqual(replayTrendCandles({...base,candles:trend.slice(0,5)}).skips,[]);
});

test('after a stop-out a later breakout re-enters, and positions never overlap',()=>{
 // Bar 7 closes 117 above prior highs 116/112; ATR(2)=(2+7)/2=4.5; entry 118 at bar 8.
 const candles=[...trend,bar(6,111,112,110,111),bar(7,111,118,111,117),bar(8,118,119,117,118)];
 const trades=replayTrendCandles({...base,candles}).hypotheticalTrades;
 assert.deepEqual(trades.map(t=>[t.signalIndex,t.entryIndex,t.exitIndex,t.exitReason]),[[2,3,5,'stop'],[7,8,8,'end_of_data']]);
 assert.deepEqual([trades[1]!.atrAtSignal,trades[1]!.initialStopPrice,trades[1]!.trailingDistance],['4.5','109','6.75']);
});

test('results stay research-only and disclose assumptions, missing evidence and an input-bound hash',()=>{
 const result=replayTrendCandles(base);
 assert.equal(result.status,'insufficient');assert.equal(result.executionAuthorized,false);
 assert.equal(result.engineVersion,'breakout-atr-trailing-v1');
 for(const item of ['verified_historical_availability','registered_executable_rules','historical_universe','realistic_fill_and_cost_evidence']) assert.ok(result.missing.includes(item));
 for(const item of ['entry_at_next_open','stop_uses_prior_completed_bar_extremes','gap_fills_at_open','end_of_data_marked_at_last_close']) assert.ok(result.assumptions.includes(item));
 assert.match(result.inputSha256,/^[a-f0-9]{64}$/);
 assert.notEqual(result.inputSha256,replayTrendCandles({...base,rule:{...base.rule,trailingStopAtr:'2'}}).inputSha256);
});

test('rejects unordered, gapped or inconsistent candles and unsupported or unknown assumptions',()=>{
 const withCandle=(index:number,patch:object)=>({candles:trend.map((c,i)=>i===index?{...c,...patch}:c)});
 const cases:object[]=[
  {candles:[...trend].reverse()},
  {candles:[...trend.slice(0,3),...trend.slice(4)]},
  withCandle(3,{closeTime:3*H+1}),
  withCandle(3,{high:'103'}),
  withCandle(3,{close:'111'}),
  withCandle(3,{open:'103'}),
  withCandle(3,{low:'0'}),
  withCandle(3,{close:'1e2'}),
  {candles:[]},
  {market:{...base.market,product:'usdt_perpetual'}},
  {market:{...base.market,baseQuantity:'0'}},
  {cost:{...base.cost,funding:'unknown'}},
  {cost:{...base.cost,exitFeePpm:-1}},
  {rule:{...base.rule,breakoutLookback:0}},
  {rule:{...base.rule,trailingStopAtr:'0'}},
  {rule:{...base.rule,initialStopAtr:'-2'}},
  {resolutionMs:0},
  {approved:true},
 ];
 for(const change of cases) assert.throws(()=>replayTrendCandles({...base,...change}),(error:unknown)=>(error as {code?:string}).code==='INVALID_INPUT',JSON.stringify(change));
});

test('candles in the history manifest format, volume included, replay identically',()=>{
 const volume={vol:'10',volCcy:'1000',volCcyQuote:'1000',units:{vol:'base',volCcy:'quote',volCcyQuote:'quote'}};
 const manifestCandles=trend.map(c=>({...c,volume}));
 assert.deepEqual(replayTrendCandles({...base,candles:manifestCandles}).hypotheticalTrades,replayTrendCandles(base).hypotheticalTrades);
 assert.throws(()=>replayTrendCandles({...base,candles:trend.map(c=>({...c,volume:{...volume,vol:'-1'}}))}));
});

test('a manifest produced by collectHistory feeds the replay directly',async()=>{
 // OKX returns newest first: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm].
 const rows=[...trend].reverse().map(c=>[String(c.ts),c.open,c.high,c.low,c.close,'1','100','100','1']);
 const pages=[rows,[]];
 const client:PublicClient={site:'global',async get<T>(path:string,query:Record<string,string>){
  const data=(pages.shift() ?? []) as T[]; const endpoint=path+'?'+new URLSearchParams(query);
  return {ok:true as const,endpoint,rows:data,raw:{endpoint,receivedAt:'2024-01-02T00:00:00.000Z',status:200,body:JSON.stringify({code:'0',data})}};
 }};
 const manifest=await collectHistory(client,{instId:'BTC-USDT',product:'spot',resolution:'1H',start:0,end:6*H,asOf:6*H,limit:100,maxPages:2,capturedAt:'2024-01-02T00:00:00.000Z'});
 assert.equal(manifest.candleCoverage,'complete');
 assert.deepEqual(replayTrendCandles({...base,candles:manifest.candles}).hypotheticalTrades,replayTrendCandles(base).hypotheticalTrades);
});

test('rejects getters without evaluating or echoing them',()=>{
 const hostile=Object.defineProperty({...base},'candles',{enumerable:true,get(){throw Error('private-sentinel')}});
 assert.throws(()=>replayTrendCandles(hostile),(error:unknown)=>{assert.doesNotMatch(String(error)+JSON.stringify(error),/sentinel/);return true});
});

test('a perpetual long pays or receives realized funding at each settlement it holds through',()=>{
 const perp={...base,market:{...base.market,product:'usdt_perpetual'},cost:{...base.cost,funding:'realized_events'}};
 // Entry bar 3 opens at 3H; the stop exit happens inside bar 5, bounded by its close at 6H.
 // Held settlements: 4H at close 109 (+0.001) and 5H at close 114 (-0.0005); 3H and 6H are outside.
 const fundingEvents=[3,4,5,6].map((h,i)=>({fundingTime:h*H,realizedRate:['0.5','0.001','-0.0005','0.5'][i]!}));
 const result=replayTrendCandles({...perp,fundingEvents});
 const trade=result.hypotheticalTrades[0]!;
 assert.deepEqual([trade.fundingUsdt,trade.netUsdt],['0.104','9.603']);
 assert.ok(result.missing.includes('funding_coverage_unknown'));
 assert.equal(replayTrendCandles(base).hypotheticalTrades[0]!.fundingUsdt,'0');
 for(const bad of [{...base,fundingEvents},{...perp,cost:{...perp.cost,funding:'not_applicable'},fundingEvents},{...perp}]) assert.throws(()=>replayTrendCandles(bad),(e:unknown)=>(e as {code?:string}).code==='INVALID_INPUT');
});
