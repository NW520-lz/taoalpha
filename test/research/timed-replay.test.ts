import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replayObservedMarks} from '../../src/research/research-evaluation.ts';

const base={schemaVersion:1,market:{product:'spot',baseQuantityAtoms:'100000000',quote:'USDT'},rule:{kind:'mark_above_reference',referencePriceMicro:'90000000',holdObservations:1},cost:{entryFeePpm:1000,exitFeePpm:1000,entryImpactPpm:2000,exitImpactPpm:2000,funding:'not_applicable'},marks:[{observedAtMs:1000,availableAtMs:1100,priceMicro:'100000000'},{observedAtMs:1200,availableAtMs:1200,priceMicro:'100000000'},{observedAtMs:1300,availableAtMs:1300,priceMicro:'110000000'}]};

test('observable marks replay a specified rule without promoting assumptions to validation',()=>{
 const result=replayObservedMarks(base);
 assert.equal(result.status,'insufficient');assert.equal(result.executionAuthorized,false);
 assert.ok(result.missing.includes('verified_historical_availability'));
 assert.equal(result.hypotheticalTrades.length,1);
 assert.equal(result.hypotheticalTrades[0]?.grossUsdtE20,'1000000000000000000000');
 assert.equal(result.hypotheticalTrades[0]?.feesUsdtE20,'21000000000000000000');
 assert.equal(result.hypotheticalTrades[0]?.impactUsdtE20,'42000000000000000000');
 assert.equal(result.hypotheticalTrades[0]?.netUsdtE20,'937000000000000000000');
});

test('a late or unavailable observation cannot be used before it becomes available',()=>{
 const late={...base,marks:[{...base.marks[0]!,availableAtMs:1200},...base.marks.slice(1)]};
 const result=replayObservedMarks(late);
 assert.equal(result.hypotheticalTrades.length,0);
 assert.ok(result.skips.includes('no_later_execution_marks'));
 const missing={...base,marks:[{...base.marks[0]!,availableAtMs:null},...base.marks.slice(1)]};
 const unknown=replayObservedMarks(missing);
 assert.equal(unknown.status,'insufficient');assert.deepEqual(unknown.hypotheticalTrades,[]);
 assert.ok(unknown.missing.includes('observation_availability_missing'));
});

test('rejects unbounded numeric data, out-of-order marks, unknown costs and unsupported products',()=>{
 for(const change of [{marks:[...base.marks].reverse()},{market:{...base.market,product:'usdt_perpetual'}},{cost:{...base.cost,entryFeePpm:-1}},{cost:{...base.cost,funding:'unknown'}},{market:{...base.market,baseQuantityAtoms:'1'.repeat(81)}},{approved:true}]) assert.throws(()=>replayObservedMarks({...base,...change}));
});

test('rejects getters and unexpected private details without echoing them',()=>{
 const hostile=Object.defineProperty({...base},'marks',{enumerable:true,get(){throw Error('private-sentinel')}});
 assert.throws(()=>replayObservedMarks(hostile),(error:unknown)=>{assert.doesNotMatch(String(error)+JSON.stringify(error),/sentinel/);return true});
});

test('records a losing hypothetical trade and does not double-count overlapping positions',()=>{
 const marks=[100,101,95,97,90].map((price,i)=>({observedAtMs:1000+i*100,availableAtMs:1000+i*100,priceMicro:String(price*1000000)}));
 const result=replayObservedMarks({...base,rule:{...base.rule,holdObservations:1},marks});
 assert.deepEqual(result.hypotheticalTrades.map(t=>[t.signalIndex,t.entryIndex,t.exitIndex]),[[0,1,2]]);
 assert.ok(BigInt(result.hypotheticalTrades[0]!.netUsdtE20)<0n);
 assert.ok(result.skips.includes('no_later_execution_marks'));
});

test('input hash binds the numeric rule and cost assumptions',()=>{
 const one=replayObservedMarks(base);
 const second=replayObservedMarks({...base,cost:{...base.cost,entryFeePpm:2000}});
 assert.notEqual(one.inputSha256,second.inputSha256);
 assert.notEqual(one.hypotheticalTrades[0]?.netUsdtE20,second.hypotheticalTrades[0]?.netUsdtE20);
});
