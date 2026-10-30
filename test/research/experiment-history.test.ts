import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../../src/store/db.ts';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {createExperimentRegistry} from '../../src/research/experiment-registry.ts';
import {inspectExperimentHistory} from '../../src/research/experiment-history.ts';
import type {PublicClient} from '../../src/okx/public-client.ts';
const now=()=>new Date('2026-01-01T00:00:00.000Z');
const row=(t:number)=>[String(t),'1','1','1','1','0','0','0','1'];
const client:PublicClient={site:'global',async get<T>(path:string){const rows=[row(120000),row(60000),row(0)] as T[];return {ok:true as const,endpoint:path,rows,raw:{endpoint:path,receivedAt:'1970-01-02T00:00:00.000Z',status:200,body:JSON.stringify(rows)}}}};
const expected={site:'global',instId:'BTC-USDT',product:'spot',resolution:'1m'} as const;
async function setup(){
 const db=openDb(':memory:');const registry=createExperimentRegistry(db,now);
 const manifest=await collectHistory(client,{...expected,start:0,end:180000,asOf:180000,limit:10,maxPages:1,capturedAt:'1970-01-02T00:00:00.000Z'});
 const id=saveHistory(db,manifest); const input={experimentId:'experiment:one',version:1,attemptId:'attempt:one',strategy:{id:'strategy:one',version:1,entryRules:'entry',exitRules:'exit',invalidationRules:'invalid'},data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion},code:{reference:'code:one',sha256:'b'.repeat(64),version:'v1'},costs:{fees:'unknown',spread:'unknown',slippage:'unknown',funding:'unknown',execution:'unknown'},windows:{exploration:{start:'1970-01-01T00:00:00Z',end:'1970-01-01T00:01:00Z'},validation:{start:'1970-01-01T00:01:00Z',end:'1970-01-01T00:02:00Z'},evaluation:{start:'1970-01-01T00:02:00Z',end:'1970-01-01T00:03:00Z'}},evaluation:{metrics:'unknown',thresholds:'unknown',baseline:'unknown',method:'unknown'}};
 registry.register(input); return {db,registry,manifest,input};
}
test('frozen data reference and all windows match without granting readiness',async()=>{
 const {db,registry,manifest}=await setup();try {const before=db.prepare('SELECT total_changes() n').get()!.n; const result=inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:1,expected});
 assert.equal(result.binding,'matched');assert.equal(result.expectedScopeBinding,'caller_supplied_unbound');assert.equal(result.reportedCandleCoverage,'complete');assert.deepEqual(result.gaps,manifest.gaps);assert.equal(result.status,'unvalidated');assert.equal(result.executionAuthorized,false);assert.equal(db.prepare('SELECT total_changes() n').get()!.n,before);
 }finally{db.close()}
});
test('caller scope mismatch and missing or modified registry data fail closed',async()=>{
 const {db,registry}=await setup();try {
 for(const changed of [{site:'us'},{instId:'ETH-USDT'},{product:'usdt_perpetual'},{resolution:'5m'}]) assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:1,expected:{...expected,...changed}}));
 assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'missing',version:1,expected}));
 db.exec("DROP TRIGGER history_manifests_no_update; UPDATE history_manifests SET content_sha256='bad'");assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:1,expected}));
 }finally{db.close()}
});



test('mismatched data version, insufficient time range and raw-source hash reject',async()=>{
 for(const variant of ['version','range','source']) {
  const {db,registry,manifest,input}=await setup();try {
   const altered=structuredClone(manifest);
   if(variant==='range') altered.request.end=120000;
   if(variant==='source') altered.sources[0]!.body='synthetic-inconsistent-sentinel';
   const id=saveHistory(db,altered);
   const data={reference:id,sha256:id.slice(8),version:variant==='version'?'other':altered.parsingVersion};
   registry.register({...input,version:2,attemptId:'attempt:two',data});
   assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:2,expected}),(e:unknown)=>{assert.doesNotMatch(String(e)+JSON.stringify(e),/sentinel/);return true});
  }finally{db.close()}
 }
});
test('partial coverage and source gaps stay visible and never become an evaluation result',async()=>{
 const {db,registry,manifest,input}=await setup();try {
  const altered={...manifest,candleCoverage:'partial' as const,gaps:[...manifest.gaps,'candle_source_failed']};const id=saveHistory(db,altered);
  registry.register({...input,version:2,attemptId:'attempt:two',data:{reference:id,sha256:id.slice(8),version:altered.parsingVersion}});
  const result=inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:2,expected});
  assert.equal(result.reportedCandleCoverage,'partial');assert.ok(result.gaps.includes('candle_source_failed'));
  assert.equal(result.availability,'historical_publication_unverified');assert.equal(result.historicalUniverse,'unknown_survivorship_gap');assert.equal(result.status,'unvalidated');
 } finally {db.close()}
});
test('missing manifest and invalid input are read-only failures',async()=>{
 const {db,registry}=await setup();try {
  const before=db.prepare('SELECT total_changes() n').get()!.n;
  for(const input of [{experimentId:'experiment:one',version:1,expected,approved:true},{experimentId:'experiment:one',version:1,expected:{...expected,site:'private-sentinel'}}]) assert.throws(()=>inspectExperimentHistory(db,registry,input),(e:unknown)=>{assert.doesNotMatch(String(e)+JSON.stringify(e),/sentinel/);return true});
  db.exec('DROP TRIGGER history_manifests_no_delete; DELETE FROM history_manifests'); const after=db.prepare('SELECT total_changes() n').get()!.n;
  assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:1,expected}));assert.equal(db.prepare('SELECT total_changes() n').get()!.n,after);assert.equal(Number(after),Number(before)+1);
 }finally{db.close()}
});

test('source failures are reported even when manifest coverage says complete',async()=>{
 const {db,registry,manifest,input}=await setup();try {
  const altered=structuredClone(manifest);altered.sources[0]!.error='network';altered.gaps=[];
  const id=saveHistory(db,altered);registry.register({...input,version:2,attemptId:'attempt:two',data:{reference:id,sha256:id.slice(8),version:altered.parsingVersion}});
  const result=inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:2,expected});
  assert.equal(result.observedSourceFailures,1);assert.ok(result.unknowns.includes('candle_coverage_not_independently_verified'));assert.equal(result.status,'unvalidated');
 }finally{db.close()}
});
