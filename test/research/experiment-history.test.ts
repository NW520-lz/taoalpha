import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../../src/store/db.ts';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {createExperimentRegistry} from '../../src/research/experiment-registry.ts';
import {inspectExperimentHistory} from '../../src/research/experiment-history.ts';
import type {PublicClient} from '../../src/okx/public-client.ts';
import {expectDomainError} from '../helpers/assertions.ts';
import {canonicalJson,sha256} from '../../src/lib/hash.ts';
const now=()=>new Date('2026-01-01T00:00:00.000Z');
const row=(t:number)=>[String(t),'1','1','1','1','0','0','0','1'];
const client:PublicClient={site:'global',async get<T>(path:string){const rows=[row(120000),row(60000),row(0)] as T[];return {ok:true as const,endpoint:path,rows,raw:{endpoint:path,receivedAt:'1970-01-02T00:00:00.000Z',status:200,body:JSON.stringify(rows)}}}};
const expected={site:'global',instId:'BTC-USDT',product:'spot',resolution:'1m'} as const;
async function setup(){
 const db=openDb(':memory:');const registry=createExperimentRegistry(db,now);
 const manifest=await collectHistory(client,{...expected,start:0,end:180000,asOf:180000,limit:10,maxPages:1,capturedAt:'1970-01-02T00:00:00.000Z'});
 const id=saveHistory(db,manifest); const input={experimentId:'experiment:one',version:1,attemptId:'attempt:one',strategy:{id:'strategy:one',version:1,entryRules:'entry',exitRules:'exit',invalidationRules:'invalid'},data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:expected},code:{reference:'code:one',sha256:'b'.repeat(64),version:'v1'},costs:{fees:'unknown',spread:'unknown',slippage:'unknown',funding:'unknown',execution:'unknown'},windows:{exploration:{start:'1970-01-01T00:00:00Z',end:'1970-01-01T00:01:00Z'},validation:{start:'1970-01-01T00:01:00Z',end:'1970-01-01T00:02:00Z'},evaluation:{start:'1970-01-01T00:02:00Z',end:'1970-01-01T00:03:00Z'}},evaluation:{metrics:'unknown',thresholds:'unknown',baseline:'unknown',method:'unknown'}};
 registry.register(input); return {db,registry,manifest,input};
}
test('frozen data reference and all windows match without granting readiness',async()=>{
 const {db,registry,manifest}=await setup();try {const before=db.prepare('SELECT total_changes() n').get()!.n; const result=inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:1,expected});
 assert.equal(result.binding,'matched');assert.equal(result.expectedScopeBinding,'registration_bound');assert.equal(result.reportedCandleCoverage,'complete');assert.deepEqual(result.gaps,manifest.gaps);assert.equal(result.status,'unvalidated');assert.equal(result.executionAuthorized,false);assert.equal(db.prepare('SELECT total_changes() n').get()!.n,before);
 }finally{db.close()}
});
test('schema 1 history inspection remains explicitly unbound',async()=>{
 const {db,registry,input}=await setup();try {
  const {scope,...data}=input.data;const original={...input,experimentId:'experiment:legacy',attemptId:'attempt:legacy',data};
  const body={...original,schemaVersion:1,registeredAt:now().toISOString(),status:'unvalidated',dataAvailability:'unverified',executionAuthorized:false};const old={...body,contentSha256:sha256(canonicalJson(body))};
  db.prepare('INSERT INTO experiment_preregistrations VALUES(?,?,?,?,?)').run(old.experimentId,old.version,old.attemptId,canonicalJson(old),old.contentSha256);
  assert.deepEqual(registry.register(original),old);
  const result=inspectExperimentHistory(db,registry,{experimentId:old.experimentId,version:1,expected});assert.equal(result.expectedScopeBinding,'caller_supplied_unbound');assert.ok(result.unknowns.includes('scope_not_frozen_in_registration'));
 }finally{db.close()}
});

test('schema 2 freezes scope and rejects a manifest or caller scope mismatch',async()=>{
 const {db,registry,input,manifest}=await setup();try {
  const second={...input,version:2,attemptId:'scoped',data:{...input.data,scope:expected}};
  const record=registry.register(second);
  assert.equal(record.schemaVersion,2);assert.deepEqual(record.data.scope,expected);
  assert.deepEqual(registry.register(second),record);
  assert.throws(()=>registry.register({...second,data:{...second.data,scope:{...expected,instId:'ETH-USDT'}}}));
  const result=inspectExperimentHistory(db,registry,{experimentId:input.experimentId,version:2,expected});
  assert.equal(result.expectedScopeBinding,'registration_bound');assert.equal(result.status,'unvalidated');assert.equal(result.executionAuthorized,false);
  assert.ok(!result.unknowns.includes('scope_not_frozen_in_registration'));
  assert.ok(result.unknowns.includes('scope_registration_declaration_unverified'));
  assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:input.experimentId,version:2,expected:{...expected,resolution:'5m'}}));
  const altered={...manifest,request:{...manifest.request,instId:'ETH-USDT'}};const otherId=saveHistory(db,altered);
  registry.register({...second,version:3,attemptId:'wrong-manifest',data:{...second.data,reference:otherId,sha256:otherId.slice(8)}});
  assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:input.experimentId,version:3,expected}));
 }finally{db.close()}
});
test('caller scope mismatch and missing or modified registry data fail closed',async()=>{
 const {db,registry}=await setup();try {
 for(const changed of [{site:'us'},{instId:'ETH-USDT'},{product:'usdt_perpetual'},{resolution:'5m'}]) assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:1,expected:{...expected,...changed}}));
 assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'missing',version:1,expected}));
 db.exec("DROP TRIGGER history_manifests_no_update; UPDATE history_manifests SET content_sha256='bad'");
 expectDomainError(()=>inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:1,expected}),'PERSISTENCE_UNAVAILABLE');
 }finally{db.close()}
});



test('mismatched data version, insufficient time range and raw-source hash reject',async()=>{
 for(const variant of ['version','range','source']) {
  const {db,registry,manifest,input}=await setup();try {
   const altered=structuredClone(manifest);
   if(variant==='range') altered.request.end=120000;
   if(variant==='source') altered.sources[0]!.body='synthetic-inconsistent-sentinel';
   const id=saveHistory(db,altered);
   const data={reference:id,sha256:id.slice(8),version:variant==='version'?'other':altered.parsingVersion,scope:expected};
   registry.register({...input,version:2,attemptId:'attempt:two',data});
   assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:2,expected}),(e:unknown)=>{assert.doesNotMatch(String(e)+JSON.stringify(e),/sentinel/);return true});
  }finally{db.close()}
 }
});
test('partial coverage and source gaps stay visible and never become an evaluation result',async()=>{
 const {db,registry,manifest,input}=await setup();try {
  const altered={...manifest,candleCoverage:'partial' as const,gaps:[...manifest.gaps,'candle_source_failed']};const id=saveHistory(db,altered);
  registry.register({...input,version:2,attemptId:'attempt:two',data:{reference:id,sha256:id.slice(8),version:altered.parsingVersion,scope:expected}});
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
  const id=saveHistory(db,altered);registry.register({...input,version:2,attemptId:'attempt:two',data:{reference:id,sha256:id.slice(8),version:altered.parsingVersion,scope:expected}});
  const result=inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:2,expected});
  assert.equal(result.observedSourceFailures,1);assert.ok(result.unknowns.includes('candle_coverage_not_independently_verified'));assert.equal(result.status,'unvalidated');
 }finally{db.close()}
});

test('maximum-window collector output preserves every gap including invalid candle rows',async()=>{
 const {db,registry,input}=await setup();try {
  const end=100000*60000; let page=0; const fake:PublicClient={site:'global',async get<T>(path:string){const rows=Array.from({length:100},(_,i)=>[String(end-(page*100+i+1)*60000),'1','1','1','1','0','0','0','0']) as T[]; page++; return {ok:true as const,endpoint:path,rows,raw:{endpoint:path,receivedAt:'1970-03-12T00:00:00.000Z',status:200,body:JSON.stringify(rows)}}}};
  const manifest=await collectHistory(fake,{...expected,start:0,end,asOf:end,limit:100,maxPages:100,capturedAt:'1970-03-12T00:00:00.000Z'}); assert.ok(manifest.gaps.length>110004);
  const id=saveHistory(db,manifest); registry.register({...input,version:2,attemptId:'large-gap',data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:expected}});
  const out=inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:2,expected}); assert.deepEqual(out.gaps,manifest.gaps);
 }finally{db.close()}
});

test('storage failure categories survive with sanitized details',async()=>{
 const {db,registry}=await setup();try {
  const {DomainError}=await import('../../src/lib/errors.ts');
  const broken={get(){throw new DomainError('PERSISTENCE_UNAVAILABLE','secret-storage-sentinel')}};
  assert.throws(()=>inspectExperimentHistory(db,broken,{experimentId:'experiment:one',version:1,expected}),(e:unknown)=>{assert.ok(e instanceof DomainError);assert.equal(e.code,'PERSISTENCE_UNAVAILABLE');assert.doesNotMatch(String(e)+JSON.stringify(e),/sentinel/);return true});
  db.close();
  assert.throws(()=>inspectExperimentHistory(db,registry,{experimentId:'experiment:one',version:1,expected}),(e:unknown)=>{assert.ok(e instanceof DomainError);assert.equal(e.code,'PERSISTENCE_UNAVAILABLE');assert.doesNotMatch(String(e)+JSON.stringify(e),/sqlite|database is not open/i);return true});
 }finally{if(db.isOpen)db.close()}
});

test('a manifest collected over more than 200 pages is still inspected',async()=>{
 // One 1m candle per page: 250 pages, within the collector's 1000-page bound.
 const paged:PublicClient={site:'global',async get<T>(path:string,query:Record<string,string>){const ts=Math.ceil(Number(query.after)/60000)*60000-60000;const rows=(ts>=0 ? [row(ts)] : []) as T[];return {ok:true as const,endpoint:path,rows,raw:{endpoint:path,receivedAt:'1970-01-02T00:00:00.000Z',status:200,body:JSON.stringify(rows)}}}};
 const db=openDb(':memory:');const registry=createExperimentRegistry(db,now);try {
  const end=250*60000, manifest=await collectHistory(paged,{...expected,start:0,end,asOf:end,limit:1,maxPages:1000,capturedAt:'1970-01-02T00:00:00.000Z'});
  assert.ok(manifest.sources.length>200);
  const id=saveHistory(db,manifest);const iso=(m:number)=>new Date(m*60000).toISOString();
  registry.register({experimentId:'experiment:paged',version:1,attemptId:'attempt:paged',strategy:{id:'strategy:paged',version:1,entryRules:'entry',exitRules:'exit',invalidationRules:'invalid'},data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:expected},code:{reference:'code:one',sha256:'b'.repeat(64),version:'v1'},costs:{fees:'unknown',spread:'unknown',slippage:'unknown',funding:'unknown',execution:'unknown'},windows:{exploration:{start:iso(0),end:iso(100)},validation:{start:iso(100),end:iso(200)},evaluation:{start:iso(200),end:iso(250)}},evaluation:{metrics:'unknown',thresholds:'unknown',baseline:'unknown',method:'unknown'}});
  assert.equal(inspectExperimentHistory(db,registry,{experimentId:'experiment:paged',version:1,expected}).reportedCandleCoverage,'complete');
 }finally{db.close()}
});
