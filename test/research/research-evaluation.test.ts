import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSyntheticFixture, assessHistoricalReadiness} from '../../src/research/research-evaluation.ts';
const fixture={schemaVersion:1,provenance:'synthetic_fixture',instrument:{product:'spot',quote:'USDT',quantityUnit:'base_atoms_1e-8',priceUnit:'usdt_micro'},rule:{kind:'close_above_reference',referencePriceMicro:'90000000'},signal:{closeTimeMs:1000,availableAtMs:1100,closePriceMicro:'100000000'},entry:{timeMs:1200,priceAvailableAtMs:1200,priceMicro:'100000000'},exit:{timeMs:1300,priceAvailableAtMs:1300,priceMicro:'110000000'},quantityBaseAtoms:'100000000',cost:{priceIncludesSpreadAndSlippage:true,entryFeePpm:1000,exitFeePpm:1000,funding:'not_applicable'}};
test('synthetic calculation counts each fee once and reports exact unit',()=>{
 const r=evaluateSyntheticFixture(fixture);assert.equal(r.outcome,'hypothetical_trade');assert.equal(r.grossUsdtE20,'1000000000000000000000');assert.equal(r.feesUsdtE20,'21000000000000000000');assert.equal(r.netUsdtE20,'979000000000000000000');assert.equal(r.status,'unvalidated');assert.equal(r.executionAuthorized,false);
});
test('signal, timeline, product, price assumptions and arbitrary input fail closed',()=>{
 for(const change of [{signal:{...fixture.signal,availableAtMs:1200}},{signal:{...fixture.signal,closeTimeMs:1150,availableAtMs:1100}},{entry:{...fixture.entry,priceAvailableAtMs:1201}},{exit:{...fixture.exit,timeMs:1200}},{instrument:{...fixture.instrument,product:'usdt_perpetual'}},{cost:{...fixture.cost,priceIncludesSpreadAndSlippage:false}},{quantityBaseAtoms:'1e8'},{provenance:'history'},{approved:true}]) assert.throws(()=>evaluateSyntheticFixture({...fixture,...change}));
 const result=evaluateSyntheticFixture({...fixture,rule:{...fixture.rule,referencePriceMicro:'100000000'}});assert.equal(result.outcome,'no_signal');assert.equal(result.netUsdtE20,null);
});
test('actual registered history remains insufficient until evidence contracts exist',()=>{
 const result=assessHistoricalReadiness();assert.equal(result.status,'insufficient');assert.equal(result.executionAuthorized,false);assert.ok(result.missing.includes('verified_historical_availability'));
});
