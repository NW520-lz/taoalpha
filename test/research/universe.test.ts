import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {aggregateUniverse} from '../../src/research/universe.ts';
import {expectDomainError} from '../helpers/assertions.ts';
import {H,ohlc,expected,setup,fakeHistoryClient} from '../helpers/experiment-fixtures.ts';
import type {Db} from '../../src/store/db.ts';

const iso=(h:number)=>new Date(h*H).toISOString();
// ETH breaks out like BTC (entry 105 at bar 3) but is stopped at 106-4.5=101.5 on bar 4: net -8.239.
const flat=[101,102,100,101];
const eth=[...ohlc.slice(0,3),[105,106,104,105],[105,106,100,101],...Array.from({length:7},()=>flat)];
const base={minRealizedTrades:1,maxValidationDecay:'0.4',normalizationDays:1,requirePositiveNet:true};
const request={experimentId:'experiment:trend',version:1,expected,window:'exploration'};

async function saveEth(db:Db,instId='ETH-USDT') {
 const manifest=await collectHistory(fakeHistoryClient(eth),{instId,product:'spot',resolution:'1H',start:0,end:12*H,asOf:12*H,limit:100,maxPages:2,capturedAt:'1970-01-02T00:00:00.000Z'});
 const id=saveHistory(db,manifest);
 return {reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:{...expected,instId}};
}

test('a universe replays each bound instrument and reports totals, groups and regimes in exit order',async()=>{
 const {db,registry,input}=await setup();try {
  const universe={instruments:[{group:'majors',data:input.data},{group:'alts',data:await saveEth(db)}],regimes:[{label:'early',start:iso(0),end:iso(3)},{label:'late',start:iso(3),end:iso(6)}]};
  registry.register({...input,universe,gates:{...base,multiInstrument:{minPositiveGroupShare:'0.5',minPositiveRegimes:1}}});
  const result=aggregateUniverse(db,registry,request);
  assert.deepEqual(result.instruments!.map(i=>[i.instId,i.group,i.metrics!.netUsdt]),[['BTC-USDT','majors','9.707'],['ETH-USDT','alts','-8.239']]);
  // ETH exits at bar 4 before BTC at bar 5, so cumulative net dips to -8.239 first.
  assert.deepEqual([result.total!.realizedTrades,result.total!.netUsdt,result.total!.maxDrawdownUsdt,result.total!.tradeNetsUsdt],[2,'1.468','8.239',['-8.239','9.707']]);
  assert.deepEqual(result.groups!.map(g=>[g.group,g.metrics.netUsdt]),[['majors','9.707'],['alts','-8.239']]);
  assert.deepEqual(result.regimes!.map(r=>[r.label,r.metrics.realizedTrades,r.metrics.netUsdt]),[['early',0,null],['late',2,'1.468']]);
  assert.deepEqual([result.universeGate,result.reasons,result.survivorshipGap],['met',[],true]);
 }finally{db.close()}
});

test('too few positive groups or regimes fails, and universes must share one frozen scope shape',async()=>{
 const {db,registry,input}=await setup();try {
  const data=await saveEth(db);
  const universe={instruments:[{group:'majors',data:input.data},{group:'alts',data}],regimes:[{label:'early',start:iso(0),end:iso(3)},{label:'late',start:iso(3),end:iso(6)}]};
  registry.register({...input,universe,gates:{...base,multiInstrument:{minPositiveGroupShare:'0.6',minPositiveRegimes:2}}});
  const result=aggregateUniverse(db,registry,request);
  assert.deepEqual([result.universeGate,result.reasons],['failed',['positive_group_share_below_minimum','positive_regimes_below_minimum']]);
  expectDomainError(()=>aggregateUniverse(db,registry,{...request,window:'evaluation'}),'UNSUPPORTED_CAPABILITY');
  const next={...input,version:2,attemptId:'attempt:trend:2'};
  expectDomainError(()=>registry.register({...next,universe:{...universe,instruments:[universe.instruments[0]!,{group:'alts',data:{...data,scope:{...data.scope,resolution:'4H'}}}]}}),'INVALID_INPUT');
  expectDomainError(()=>registry.register({...next,universe:{...universe,instruments:[universe.instruments[0]!,universe.instruments[0]!]}}),'INVALID_INPUT');
  const noUniverse=await setup();try {
   noUniverse.registry.register(noUniverse.input);
   assert.deepEqual([aggregateUniverse(noUniverse.db,noUniverse.registry,request).outcome],['blocked']);
  }finally{noUniverse.db.close()}
 }finally{db.close()}
});
