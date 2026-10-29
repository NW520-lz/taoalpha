import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfirmationService } from '../../src/control/confirmations.ts';
import { createDemoRiskPolicyService } from '../../src/risk/demo-risk-policy.ts';
import { initializeLossScope, observeEquity } from '../../src/risk/loss-ledger.ts';

const at = new Date('2026-10-29T12:00:00Z');
const policy = { id:'policy:synthetic', version:1, initialEquityUsdt:'100', budgetsUsdt:{reserve:'20',spot:'30',perpetual:'50'}, lossLinesUsdt:{review:'1',pause:'2',stop:'3'}, limits:{maxSpotAssets:2,maxPerpetualPositions:1,maxSpotPlanLossUsdt:'1',maxPerpetualPlanLossUsdt:'2',maxPerpetualLeverage:'2'} };
function setup(db = openDb(':memory:')) {
 db.exec(`CREATE TABLE demo_account_scopes(scope_id TEXT PRIMARY KEY,account_ref TEXT,site TEXT,environment TEXT); INSERT INTO demo_account_scopes VALUES('scope:synthetic','account:synthetic','global','demo'); CREATE TABLE demo_account_identity_conflicts(scope_id TEXT PRIMARY KEY); CREATE TABLE demo_account_refresh_events(seq INTEGER PRIMARY KEY,scope_id TEXT,status TEXT); INSERT INTO demo_account_refresh_events VALUES(1,'scope:synthetic','ok');`);
 let snapshot: any = {scopeId:'scope:synthetic',accountRef:'account:synthetic',site:'global',environment:'demo',generation:1,validUntilMs:at.getTime()+30000,reconciled:false,executionAuthorized:false,blockNewRisk:true};
 const session = {getInternalSnapshot:()=>snapshot};
 const confirmations = createConfirmationService(db,{reviewAndVerify:async()=>({status:'verified'})},()=>at);
 const service = createDemoRiskPolicyService(db,session as never,confirmations,()=>at);
 return {db,service,confirmations,setSnapshot:(s:any)=>{snapshot=s},snapshot};
}
test('synthetic confirmation binds complete policy and keeps execution blocked', async()=>{
 const {db,service,confirmations}=setup(); try {
  const p=service.propose({proposalId:'proposal:one',policy,expiresAt:'2026-10-29T12:01:00Z'});
  assert.equal(p.status,'pending'); assert.doesNotMatch(JSON.stringify(p),/100|budgetsUsdt/);
  const receipt=(await confirmations.reviewAndConfirm(p.requestId)).receiptId!;
  const result=service.confirm('proposal:one',receipt);
  assert.equal(result.status,'confirmed'); assert.equal(result.reconciled,false); assert.equal(result.executionAuthorized,false); assert.equal(result.blockNewRisk,true);
  assert.deepEqual(service.confirm('proposal:one',receipt),result);
 } finally {db.close()}
});

test('strict decimal policy rejects defaults, lossy objects and invalid boundaries privately',()=>{
 const {db,service}=setup(); try {
  const propose=(p:unknown)=>service.propose({proposalId:'proposal:invalid',policy:p,expiresAt:'2026-10-29T12:01:00Z'});
  const getter=Object.defineProperty({...policy},'id',{enumerable:true,get(){throw Error('private-sentinel')}});
  const invalid=[{...policy,extra:'private-sentinel'},{...policy,initialEquityUsdt:100},{...policy,initialEquityUsdt:'1e2'}, {...policy,budgetsUsdt:{...policy.budgetsUsdt,spot:'30.0000000000000000001'}}, {...policy,lossLinesUsdt:{review:'1',pause:'1',stop:'3'}}, {...policy,limits:{...policy.limits,maxPerpetualLeverage:'0.9'}}, {...policy,limits:{...policy.limits,maxSpotAssets:1.5}}, getter, Object.assign(Object.create({inherited:true}),policy), JSON.parse(JSON.stringify(policy).replace('"id":','"__proto__":{},"id":'))];
  for(const p of invalid) assert.throws(()=>propose(p),(e:unknown)=>{assert.doesNotMatch(String(e)+JSON.stringify(e),/sentinel|100|budgetsUsdt/);return true});
 } finally {db.close()}
});

test('latest account state and later same-account refresh are rechecked',async()=>{
 const {db,service,confirmations,setSnapshot,snapshot}=setup(); try {
  const p=service.propose({proposalId:'proposal:refresh',policy,expiresAt:'2026-10-29T12:01:00Z'});
  const id=(await confirmations.reviewAndConfirm(p.requestId)).receiptId!;
  db.exec("INSERT INTO demo_account_refresh_events VALUES(2,'scope:synthetic','pending')");
  assert.throws(()=>service.confirm('proposal:refresh',id));
  db.exec("INSERT INTO demo_account_refresh_events VALUES(3,'scope:synthetic','ok')");
  setSnapshot({...snapshot,generation:3,accountRef:'account:other'}); assert.throws(()=>service.confirm('proposal:refresh',id));
  setSnapshot({...snapshot,generation:3,site:'us'}); assert.throws(()=>service.confirm('proposal:refresh',id));
  setSnapshot({...snapshot,generation:3,validUntilMs:at.getTime()-1}); assert.throws(()=>service.confirm('proposal:refresh',id));
  setSnapshot({...snapshot,generation:3}); assert.equal(service.confirm('proposal:refresh',id).status,'confirmed');
 } finally {db.close()}
});

test('rollback preserves receipt and version conflicts cannot consume it',async()=>{
 const {db,service,confirmations}=setup(); try {
  const make=async(id:string,version:number)=>{const p=service.propose({proposalId:id,policy:{...policy,version},expiresAt:'2026-10-29T12:01:00Z'}); return (await confirmations.reviewAndConfirm(p.requestId)).receiptId!};
  const receipt=await make('proposal:rollback',2);
  db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON demo_risk_policy_confirmations BEGIN SELECT RAISE(ABORT,'private-sentinel'); END");
  assert.throws(()=>service.confirm('proposal:rollback',receipt));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM confirmation_consumptions').get()!.n,0);
  db.exec('DROP TRIGGER synthetic_failure'); assert.equal(service.confirm('proposal:rollback',receipt).status,'confirmed');
  for(const version of [1,2]) {const id=`proposal:conflict:${version}`;const r=await make(id,version);assert.throws(()=>service.confirm(id,r));assert.equal(confirmations.getReceipt(r).receiptId,r);}
  assert.equal(db.prepare('SELECT COUNT(*) n FROM confirmation_consumptions').get()!.n,1);
  for(const t of ['demo_risk_policy_proposals','demo_risk_policy_confirmations']) for(const command of [`UPDATE ${t} SET rowid=rowid`,`DELETE FROM ${t}`,`INSERT OR REPLACE INTO ${t} SELECT * FROM ${t}`]) assert.throws(()=>db.exec(command));
 } finally {db.close()}
});

test('unconfirmed, wrong request and identity lock fail closed without leaking private data',async()=>{
 const {db,service,confirmations}=setup(); try {
  const a=service.propose({proposalId:'proposal:a',policy,expiresAt:'2026-10-29T12:01:00Z'});
  const b=service.propose({proposalId:'proposal:b',policy,expiresAt:'2026-10-29T12:01:00Z'});
  assert.throws(()=>service.confirm('proposal:a','private-sentinel'));
  const id=(await confirmations.reviewAndConfirm(b.requestId)).receiptId!;
  assert.throws(()=>service.confirm('proposal:a',id));
  db.exec("INSERT INTO demo_account_identity_conflicts VALUES('scope:synthetic')");
  assert.throws(()=>service.confirm('proposal:b',id));
  assert.equal(service.get('proposal:a').status,'pending');
  assert.doesNotMatch(JSON.stringify(service.get('proposal:a')),/100|budget|receipt|sentinel/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM confirmation_consumptions').get()!.n,0);
  assert.equal(a.status,'pending');
 } finally {db.close()}
});

test('decision denial and expiry do not create confirmation',async()=>{
 const {db,service,confirmations}=setup(); try {
  const p=service.propose({proposalId:'proposal:expiry',policy,expiresAt:'2026-10-29T12:00:01Z'});
  const r=(await confirmations.reviewAndConfirm(p.requestId)).receiptId!;
  const expiredService=createDemoRiskPolicyService(db,{getInternalSnapshot:()=>null} as never,confirmations,()=>new Date('2026-10-29T12:00:02Z'));
  assert.throws(()=>expiredService.confirm('proposal:expiry',r));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM demo_risk_policy_confirmations').get()!.n,0);
 } finally {db.close()}
});

test('policy confirmation does not touch unrelated risk event records',async()=>{
 const {db,service,confirmations}=setup(); try {
  const { limits: _limits, ...lossPolicy } = policy;
  initializeLossScope(db,{scopeId:'synthetic-scope',policy:lossPolicy,baselineRef:'synthetic-baseline',at:'2026-01-01T00:00:00Z'});
  const loss=observeEquity(db,{scopeId:'synthetic-scope',sourceRef:'synthetic-snapshot',observedAt:'2026-01-01T00:01:00Z',equityUsdt:'96',accountReconciled:true,capitalHistoryReconciled:true});
  assert.equal(loss.state,'hard_stopped');
  const p=service.propose({proposalId:'proposal:events',policy,expiresAt:'2026-10-29T12:01:00Z'});
  const r=(await confirmations.reviewAndConfirm(p.requestId)).receiptId!;
  service.confirm('proposal:events',r);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM risk_loss_events WHERE kind='hard_stop'").get()!.n,1);
 } finally {db.close()}
});


test('two service instances serialize conflicting versions; denied decisions cannot be consumed',async()=>{
 const {db,service,confirmations,snapshot}=setup(); try {
  const second=createDemoRiskPolicyService(db,{getInternalSnapshot:()=>snapshot} as never,confirmations,()=>at);
  const p1=service.propose({proposalId:'proposal:client1',policy,expiresAt:'2026-10-29T12:01:00Z'});
  const p2=second.propose({proposalId:'proposal:client2',policy,expiresAt:'2026-10-29T12:01:00Z'});
  const r1=(await confirmations.reviewAndConfirm(p1.requestId)).receiptId!;
  const r2=(await confirmations.reviewAndConfirm(p2.requestId)).receiptId!;
  assert.equal(service.confirm('proposal:client1',r1).status,'confirmed');
  assert.throws(()=>second.confirm('proposal:client2',r2));
  const denied=createConfirmationService(db,{reviewAndVerify:async()=>({status:'denied'})},()=>at);
  const third=createDemoRiskPolicyService(db,{getInternalSnapshot:()=>snapshot} as never,denied,()=>at);
  const p3=third.propose({proposalId:'proposal:denied',policy:{...policy,version:2},expiresAt:'2026-10-29T12:01:00Z'});
  assert.equal((await denied.reviewAndConfirm(p3.requestId)).status,'denied');
  assert.throws(()=>third.confirm('proposal:denied','receipt:forged'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM confirmation_consumptions').get()!.n,1);
 } finally {db.close()}
});

test('budget sum is exact across maximum integer and fractional scale',()=>{
 const {db,service}=setup(); try {
  const large='999999999999999999999999999999999999999';
  const tiny='0.0000000000000000000000000000000000001';
  const p={...policy,initialEquityUsdt:large,budgetsUsdt:{reserve:large,spot:tiny,perpetual:'0'}};
  assert.throws(()=>service.propose({proposalId:'proposal:precision-bad',policy:p,expiresAt:'2026-10-29T12:01:00Z'}));
  const equal={...p,budgetsUsdt:{reserve:large,spot:'0',perpetual:'0'}};
  assert.equal(service.propose({proposalId:'proposal:precision-equal',policy:equal,expiresAt:'2026-10-29T12:01:00Z'}).status,'pending');
 } finally {db.close()}
});



test('expired receipt fails with otherwise current fresh account snapshot',async()=>{
 const {db,service,confirmations,snapshot}=setup(); try {
  const p=service.propose({proposalId:'proposal:expire-fresh',policy,expiresAt:'2026-10-29T12:00:01Z'});
  const receipt=(await confirmations.reviewAndConfirm(p.requestId)).receiptId!;
  const expired=createDemoRiskPolicyService(db,{getInternalSnapshot:()=>({...snapshot,validUntilMs:at.getTime()+30000})} as never,confirmations,()=>new Date(at.getTime()+1000));
  assert.throws(()=>expired.confirm('proposal:expire-fresh',receipt));
  assert.equal(confirmations.getRequest(p.requestId).status,'verified');
  assert.equal(service.get('proposal:expire-fresh').status,'pending');
 } finally {db.close()}
});

test('orphaned proposal is repaired by identical replay; corrupted frozen content is rejected',()=>{
 const {db,service}=setup(); try {
  const input={proposalId:'proposal:orphan',policy,expiresAt:'2026-10-29T12:01:00Z'};
  db.exec("CREATE TRIGGER synthetic_insert_failure BEFORE INSERT ON demo_risk_policy_proposals BEGIN SELECT RAISE(ABORT,'private-sentinel'); END");
  assert.throws(()=>service.propose(input));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM confirmation_requests').get()!.n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM demo_risk_policy_proposals').get()!.n,0);
  db.exec('DROP TRIGGER synthetic_insert_failure');
  assert.equal(service.propose(input).status,'pending');
  assert.throws(()=>service.propose({...input,policy:{...policy,version:2}}));
  db.exec("DROP TRIGGER demo_risk_policy_proposals_no_update; UPDATE demo_risk_policy_proposals SET subject_hash='private-corruption-sentinel'");
  assert.throws(()=>service.get(input.proposalId),(e:unknown)=>{assert.doesNotMatch(String(e)+JSON.stringify(e),/sentinel/);return true});
 } finally {db.close()}
});

test('independent SQLite connections enforce write lock without consuming approval',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tao-policy-')); const path=join(dir,'synthetic.sqlite');
 const db=openDb(path); let db2:ReturnType<typeof openDb>|undefined;
 try {
  const {service,confirmations,snapshot}=setup(db);
  const p=service.propose({proposalId:'proposal:independent',policy,expiresAt:'2026-10-29T12:01:00Z'});
  const receipt=(await confirmations.reviewAndConfirm(p.requestId)).receiptId!;
  db2=openDb(path); db2.exec('PRAGMA busy_timeout=0');
  const confirmations2=createConfirmationService(db2,{reviewAndVerify:async()=>({status:'denied'})},()=>at);
  const second=createDemoRiskPolicyService(db2,{getInternalSnapshot:()=>snapshot} as never,confirmations2,()=>at);
  db.exec('BEGIN IMMEDIATE');
  assert.throws(()=>second.confirm('proposal:independent',receipt));
  db.exec('ROLLBACK');
  assert.equal(confirmations.getRequest(p.requestId).status,'verified');
  assert.equal(second.confirm('proposal:independent',receipt).status,'confirmed');
  assert.equal(service.confirm('proposal:independent',receipt).status,'confirmed');
 } finally {if(db.isTransaction) db.exec('ROLLBACK'); db2?.close(); db.close(); rmSync(dir,{recursive:true,force:true})}
});
