import {test} from 'node:test';
import assert from 'node:assert/strict';
import {judgeValidation} from '../../src/research/validation-judgement.ts';
import {expectDomainError} from '../helpers/assertions.ts';
import {ohlc,expected,replay,setup,windowsAt} from '../helpers/experiment-fixtures.ts';

// Validation bars 6-11: breakout at bar 8 (ATR 3), entry 116 at bar 9, trailing stop 126-4.5=121.5 hit at bar 11.
// Net 2*(121.5-116)=11 - fees 0.475 - impact 0.95 = 9.575. Bars 12-13 form the sealed evaluation window.
const bars=[...ohlc.slice(0,6),[111,112,110,111],[111,112,110,111],[111,115,111,115],[116,121,115,120],[120,126,119,125],[125,127,120,121],[121,122,120,121],[121,122,120,121]];
const gates={minRealizedTrades:1,maxValidationDecay:'0.4',normalizationDays:1,requirePositiveNet:true};
const request={experimentId:'experiment:trend',version:1,expected};

test('exploration and validation that meet the frozen gates report a duration-normalized decay',async()=>{
 const {db,registry,input}=await setup([],bars);try {
  const record=registry.register({...input,windows:windowsAt(6,12,14),gates});
  assert.deepEqual(record.gates,gates);
  const result=judgeValidation(db,registry,request);
  // 6-hour windows normalized to one day: 9.707*4=38.828 and 9.575*4=38.3; decay 0.528/38.828.
  assert.deepEqual([result.exploration!.normalizedNetUsdt,result.validation!.normalizedNetUsdt,result.decay],['38.828','38.3','0.0135984341']);
  assert.deepEqual([result.validationGate,result.reasons],['met',[]]);
  assert.equal(result.status,'insufficient');assert.equal(result.executionAuthorized,false);
  expectDomainError(()=>registry.register({...input,windows:windowsAt(6,12,14),gates:{...gates,maxValidationDecay:'0.5'}}),'IDEMPOTENCY_CONFLICT');
 }finally{db.close()}
});

test('too much decay, a losing exploration or a losing validation fail the gate',async()=>{
 const {db,registry,input}=await setup([],bars);try {
  registry.register({...input,windows:windowsAt(6,12,14),gates:{...gates,maxValidationDecay:'0.01'}});
  const decayed=judgeValidation(db,registry,request);
  assert.deepEqual([decayed.validationGate,decayed.reasons],['failed',['validation_decay_above_limit']]);
  // Exploration 0-12h and validation 12-14h: the bar-8 winner is in exploration, validation has no trade.
  registry.register({...input,version:2,attemptId:'attempt:trend:2',windows:windowsAt(12,13,14),replay:{...replay,cost:{...replay.cost,exitFeePpm:1000000}},gates});
  const losing=judgeValidation(db,registry,{...request,version:2});
  assert.equal(losing.decay,null);
  assert.deepEqual([losing.validationGate,losing.reasons],['failed',['exploration_net_not_positive','validation_no_realized_trades']]);
 }finally{db.close()}
});

test('too few trades is insufficient, not failed, and prose-only thresholds are blocked',async()=>{
 const {db,registry,input}=await setup([],bars);try {
  registry.register({...input,windows:windowsAt(6,12,14),gates:{...gates,minRealizedTrades:2}});
  const few=judgeValidation(db,registry,request);
  assert.deepEqual([few.validationGate,few.reasons],['insufficient',['exploration_trades_below_minimum']]);
  registry.register({...input,version:2,attemptId:'attempt:trend:2',windows:windowsAt(6,12,14)});
  const prose=judgeValidation(db,registry,{...request,version:2});
  assert.deepEqual([prose.outcome,prose.reasonCode,prose.validationGate],['blocked','rules_incomplete',null]);
  const {replay:_,...noReplay}=input;
  expectDomainError(()=>registry.register({...noReplay,version:3,attemptId:'attempt:trend:3',gates}),'INVALID_INPUT');
 }finally{db.close()}
});
