import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessParameterSensitivity} from '../../src/research/sensitivity.ts';
import {expectDomainError} from '../helpers/assertions.ts';
import {expected,setup} from '../helpers/experiment-fixtures.ts';

const base={minRealizedTrades:1,maxValidationDecay:'0.4',normalizationDays:1,requirePositiveNet:true,costStressMultipliers:[1]};
const request={experimentId:'experiment:trend',version:1,expected};

test('each registered neighbourhood is replayed on exploration only and judged for smoothness',async()=>{
 const {db,registry,input}=await setup();try {
  // trailing 1 exits at 112 (net 12.698); 1.5 exits at 110.5 (9.707); 2 never stops, so no realized trade.
  registry.register({...input,gates:{...base,sensitivity:{neighbourhoods:{trailingStopAtr:['1','1.5','2']},maxAdjacentChange:'0.5',requireAllPositive:true}}});
  const result=assessParameterSensitivity(db,registry,request);
  assert.equal(result.window,'exploration');
  assert.deepEqual(result.parameters!.map(p=>[p.parameter,p.points.map(x=>[x.value,x.netUsdt]),p.adjacentChanges]),[['trailingStopAtr',[['1','12.698'],['1.5','9.707'],['2',null]],['0.2355489053',null]]]);
  assert.deepEqual([result.sensitivityGate,result.reasons,result.attempts],['insufficient',['trailingStopAtr_point_without_trades'],3]);
 }finally{db.close()}
});

test('a jump between neighbours fails, and the stop grid shows where the initial stop can bind',async()=>{
 const {db,registry,input}=await setup();try {
  registry.register({...input,gates:{...base,sensitivity:{neighbourhoods:{trailingStopAtr:['1','1.5']},stopGrid:{initialStopAtr:['1','2'],trailingStopAtr:['1.5']},maxAdjacentChange:'0.2',requireAllPositive:true}}});
  const result=assessParameterSensitivity(db,registry,request);
  assert.deepEqual([result.sensitivityGate,result.reasons],['failed',['trailingStopAtr_adjacent_change_above_limit']]);
  assert.deepEqual(result.stopGrid!.map(c=>[c.initialStopAtr,c.trailingStopAtr,c.netUsdt,c.initialStopCanBind]),[['1','1.5','9.707',true],['2','1.5','9.707',false]]);
  assert.equal(result.attempts,4);
 }finally{db.close()}
});

test('neighbourhoods must contain the registered value and be ordered; unregistered sensitivity is blocked',async()=>{
 const {db,registry,input}=await setup();try {
  const sensitivity={neighbourhoods:{trailingStopAtr:['1','2']},maxAdjacentChange:'0.5',requireAllPositive:true};
  expectDomainError(()=>registry.register({...input,gates:{...base,sensitivity}}),'INVALID_INPUT');
  expectDomainError(()=>registry.register({...input,gates:{...base,sensitivity:{...sensitivity,neighbourhoods:{trailingStopAtr:['2','1.5']}}}}),'INVALID_INPUT');
  registry.register({...input,gates:base});
  const blocked=assessParameterSensitivity(db,registry,request);
  assert.deepEqual([blocked.outcome,blocked.reasonCode],['blocked','rules_incomplete']);
 }finally{db.close()}
});
