import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {replayRelativeStrength} from '../../src/research/relative-strength.ts';
import {expectDomainError} from '../helpers/assertions.ts';
import {H,ohlc,expected,replay,setup,fakeHistoryClient} from '../helpers/experiment-fixtures.ts';
import type {Db} from '../../src/store/db.ts';

const pad=(bars:number[][],last:number[])=>[...bars,...Array.from({length:12-bars.length},()=>last)];
// Benchmark BTC: +1% from bar 0 to bar 2.
const btc=pad([[100,101,99,100],[100,101,99,100],[100,102,100,101]],[101,102,100,101]);
// At bar 2 all three break out above their prior highs (101):
// A +4% (RS 0.03, turnover 300 >= 2x100), then follows the hand-worked trend: entry 105, stop 110.5 at bar 5, net 9.707.
const a=pad([[...ohlc[0]!,100],[...ohlc[1]!,100],[...ohlc[2]!,300],...ohlc.slice(3,6)],[111,112,110,111]);
// B +3% (RS 0.02, turnover 300) loses the single slot to A.
const b=pad([[100,101,99,100,100],[100,101,99,100,100],[100,103,100,103,300]],[102,103,101,102]);
// C +5% (RS 0.04) is the strongest but turnover 150 < 2x100, so it is filtered before ranking.
const c=pad([[100,101,99,100,100],[100,101,99,100,100],[100,105,100,105,150]],[104,105,103,104]);
const selection={strengthLookback:2,volumeLookback:2,volumeMultiplier:'2',maxPositions:1};
const request={experimentId:'experiment:trend',version:1,expected,window:'exploration'};

async function member(db:Db,instId:string,bars:number[][],group:string) {
 const manifest=await collectHistory(fakeHistoryClient(bars),{instId,product:'spot',resolution:'1H',start:0,end:12*H,asOf:12*H,limit:100,maxPages:2,capturedAt:'1970-01-02T00:00:00.000Z'});
 const id=saveHistory(db,manifest);
 return {group,data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:{...expected,instId}}};
}

test('breakouts pass the turnover filter, rank by strength against the benchmark and fill only free slots',async()=>{
 const {db,registry,input}=await setup([],btc);try {
  const universe={instruments:[await member(db,'A-USDT',a,'alts'),await member(db,'B-USDT',b,'alts'),await member(db,'C-USDT',c,'alts')]};
  registry.register({...input,universe,replay:{...replay,selection}});
  const result=replayRelativeStrength(db,registry,request);
  assert.deepEqual(result.trades!.map(t=>[t.instId,t.signalOpenMs,t.entryOpenMs,t.exitOpenMs,t.exitReason,t.netUsdt]),[['A-USDT',2*H,3*H,5*H,'stop','9.707']]);
  assert.deepEqual(result.skips,[{instId:'C-USDT',signalOpenMs:2*H,reason:'turnover_not_expanded'},{instId:'B-USDT',signalOpenMs:2*H,reason:'max_positions'}]);
  assert.deepEqual([result.metrics!.realizedTrades,result.metrics!.netUsdt],[1,'9.707']);
  assert.equal(result.executionAuthorized,false);
 }finally{db.close()}
});

test('selection needs a universe, a gap-free benchmark window, and the evaluation window stays sealed',async()=>{
 const {db,registry,input}=await setup([],btc);try {
  expectDomainError(()=>registry.register({...input,replay:{...replay,selection}}),'INVALID_INPUT');
  const universe={instruments:[await member(db,'A-USDT',a,'alts'),await member(db,'B-USDT',b,'alts')]};
  registry.register({...input,universe,replay:{...replay,selection}});
  expectDomainError(()=>replayRelativeStrength(db,registry,{...request,window:'evaluation'}),'UNSUPPORTED_CAPABILITY');
 }finally{db.close()}
 const gapped=await setup([1],btc);try {
  const universe={instruments:[await member(gapped.db,'A-USDT',a,'alts'),await member(gapped.db,'B-USDT',b,'alts')]};
  gapped.registry.register({...gapped.input,universe,replay:{...replay,selection}});
  const result=replayRelativeStrength(gapped.db,gapped.registry,request);
  assert.deepEqual([result.outcome,result.reasonCode],['blocked','missing_required_evidence']);
 }finally{gapped.db.close()}
});
