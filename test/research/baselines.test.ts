import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareWithBaselines} from '../../src/research/baselines.ts';
import {expectDomainError} from '../helpers/assertions.ts';
import {expected,replay,setup} from '../helpers/experiment-fixtures.ts';

const gates={minRealizedTrades:1,maxValidationDecay:'0.4',normalizationDays:1,requirePositiveNet:true,costStressMultipliers:[1,2,3]};
const request={experimentId:'experiment:trend',version:1,expected,window:'exploration'};

test('a window shows the strategy under registered cost multipliers beside hold and no-trade baselines',async()=>{
 const {db,registry,input}=await setup();try {
  registry.register({...input,gates});
  const result=compareWithBaselines(db,registry,request);
  // Strategy trade: gross 11; costs 1.293 per unit multiplier.
  assert.deepEqual(result.costStress!.map(s=>[s.multiplier,s.metrics!.netUsdt]),[[1,'9.707'],[2,'8.414'],[3,'7.121']]);
  // Hold: buy the first open 100, sell the last close 111, qty 2; marks 0,0,8,18,28,22 so drawdown 6.
  assert.deepEqual(result.hold,{entryPrice:'100',exitPrice:'111',grossUsdt:'22',feesUsdt:'0.422',impactUsdt:'0.844',netUsdt:'20.734',maxDrawdownUsdt:'6'});
  assert.deepEqual(result.noTrade,{netUsdt:'0',maxDrawdownUsdt:'0'});
  assert.equal(result.executionAuthorized,false);
 }finally{db.close()}
});

test('multipliers must be registered, bounded, and the evaluation window stays sealed',async()=>{
 const {db,registry,input}=await setup();try {
  const {costStressMultipliers:_,...noStress}=gates;
  registry.register({...input,gates:noStress});
  const unregistered=compareWithBaselines(db,registry,request);
  assert.deepEqual([unregistered.outcome,unregistered.reasonCode],['blocked','rules_incomplete']);
  // 2000 ppm impact x 600 exceeds 100% of notional.
  expectDomainError(()=>registry.register({...input,version:2,attemptId:'attempt:trend:2',gates:{...gates,costStressMultipliers:[1,600]}}),'INVALID_INPUT');
  expectDomainError(()=>registry.register({...input,version:2,attemptId:'attempt:trend:2',gates:{...gates,costStressMultipliers:[2,3]}}),'INVALID_INPUT');
  expectDomainError(()=>compareWithBaselines(db,registry,{...request,window:'evaluation'}),'UNSUPPORTED_CAPABILITY');
 }finally{db.close()}
});
