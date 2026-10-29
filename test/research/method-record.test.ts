import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { seedBundle } from '../helpers/research-fixtures.ts';
import { NOW } from '../helpers/market-fixtures.ts';
import { startResearch, nextTasks, completeTask } from '../../src/research/research-service.ts';
import { createMethodRecord, getMethodRecord } from '../../src/research/method-record.ts';

const now = () => NOW;
test('method context is frozen into each independent task and records are immutable and scoped', async () => {
 const db = openDb(':memory:'); const scan = await seedBundle(db);
 const context = { schemaVersion: 1, methodVersion: 'v1', instrument: 'GOOD-USDT', product: 'spot', observationResolution: null, evaluationHorizon: null } as const;
 const run = startResearch(db, { bundleId: scan.bundleId, agentMode: 'serial_degraded', methodContext: context }, now);
 assert.equal(run.methodContext?.methodVersion, 'v1');
 for (const t of nextTasks(db, run.runId)) assert.deepEqual(t.methodContext, run.methodContext);
 while (nextTasks(db, run.runId).length) for (const task of nextTasks(db, run.runId)) completeTask(db, {assignmentId:task.assignmentId, outcome:{kind:'failed',reason:'unavailable'}}, now);
 const candidate = scan.candidates.find(c => c.instId === 'GOOD-USDT')!;
 const evidence = db.prepare('SELECT content_sha256 FROM evidence_items WHERE id = ?').get(candidate.snapshotEvidenceId) as {content_sha256: string};
 const ref = { id: candidate.snapshotEvidenceId, sha256: evidence.content_sha256 };
 const input = { clientRef:'test-1', runId:run.runId, scope:{kind:'wait'}, principalConflict:'unknown', dominantSide:'unknown', mechanismHypothesis:'unknown', alternativeExplanations:[], supportRefs:[ref], counterRefs:[], unknowns:['cost'], invalidationConditions:['unknown'], reviewAfter:null, conclusion:'wait', reason:'unknown', reasons:{returnMechanism:'unknown', currentConditions:'unknown', evidenceUnknowns:'unknown', invalidation:'unknown', costRisk:'unknown'}, priorRecordId:null };
 const record = createMethodRecord(db, input, now);
 assert.deepEqual(createMethodRecord(db, input, now), record);
 assert.deepEqual(getMethodRecord(db, record.id), record);
 assert.throws(() => createMethodRecord(db, {...input, clientRef:'test-2', supportRefs:[{...ref,sha256:'0'.repeat(64)}]}, now));
 assert.throws(() => db.prepare('UPDATE decision_method_records SET content = ? WHERE id = ?').run('{}', record.id));
 assert.throws(() => db.prepare('DELETE FROM decision_method_records WHERE id = ?').run(record.id));
 assert.throws(() => db.prepare('INSERT OR REPLACE INTO decision_method_records SELECT * FROM decision_method_records WHERE id = ?').run(record.id));
 db.close();
});

test('method context reaches later phases, foreign refs and conflicting revisions are rejected', async () => {
 const db=openDb(':memory:'); const scan=await seedBundle(db); const foreign=await seedBundle(db);
 const run=startResearch(db,{bundleId:scan.bundleId,agentMode:'parallel_independent',methodContext:{schemaVersion:1,methodVersion:'v1',instrument:null,product:null,observationResolution:null,evaluationHorizon:null}},now);
 for(let phase=1;phase<=3;phase++) {
   const tasks=nextTasks(db,run.runId); assert.ok(tasks.length); for(const task of tasks) { assert.equal(task.phase,phase); assert.deepEqual(task.methodContext,run.methodContext); completeTask(db,{assignmentId:task.assignmentId,outcome:{kind:'failed',reason:'unavailable'}},now); }
 }
 const candidate=foreign.candidates[0]!; const ev=db.prepare('SELECT content_sha256 FROM evidence_items WHERE id = ?').get(candidate.snapshotEvidenceId) as {content_sha256:string};
 const input={clientRef:'a',runId:run.runId,scope:{kind:'wait'},principalConflict:'unknown',dominantSide:'unknown',mechanismHypothesis:'unknown',alternativeExplanations:[],supportRefs:[],counterRefs:[],unknowns:['unknown'],invalidationConditions:['unknown'],reviewAfter:null,conclusion:'wait',reason:'unknown',reasons:{returnMechanism:'unknown',currentConditions:'unknown',evidenceUnknowns:'unknown',invalidation:'unknown',costRisk:'unknown'},priorRecordId:null};
 assert.throws(()=>createMethodRecord(db,{...input,supportRefs:[{id:candidate.snapshotEvidenceId,sha256:ev.content_sha256}]},now));
 const one=createMethodRecord(db,input,now);
 assert.throws(()=>createMethodRecord(db,{...input,reason:'changed'},now));
 assert.throws(()=>createMethodRecord(db,{...input,clientRef:'b',hostVerified:true},now));
 const two=createMethodRecord(db,{...input,clientRef:'b',priorRecordId:one.id},now); assert.equal(two.priorRecordId,one.id);
 db.close();
});

test('legacy database migrates transactionally without changing existing content', async () => {
 const {DatabaseSync}=await import('node:sqlite'); const {mkdtempSync,rmSync}=await import('node:fs'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path'); const {SCHEMA}=await import('../../src/store/schema.ts');
 const dir=mkdtempSync(join(tmpdir(),'taoalpha-migration-')); const path=join(dir,'old.db');
 try { const old=new DatabaseSync(path); for(const statement of SCHEMA) old.exec(statement); old.prepare('INSERT INTO evidence_bundles VALUES (?, ?, ?, ?)').run('bundle-old','2026-01-01T00:00:00Z','{}','old-hash'); old.close();
 const migrated=openDb(path); assert.equal((migrated.prepare('SELECT content FROM evidence_bundles WHERE id = ?').get('bundle-old') as {content:string}).content,'{}'); assert.equal((migrated.prepare('SELECT count(*) AS n FROM schema_migrations').get() as {n:number}).n,2); migrated.close();
 const again=openDb(path); assert.equal((again.prepare('SELECT count(*) AS n FROM schema_migrations').get() as {n:number}).n,2); again.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('record rejects a changed stored decision, including on replay', async () => {
 const db=openDb(':memory:'); const scan=await seedBundle(db);
 const run=startResearch(db,{bundleId:scan.bundleId,agentMode:'serial_degraded',methodContext:{schemaVersion:1,methodVersion:'v1',instrument:null,product:null,observationResolution:null,evaluationHorizon:null}},now);
 while(nextTasks(db,run.runId).length) for(const task of nextTasks(db,run.runId)) completeTask(db,{assignmentId:task.assignmentId,outcome:{kind:'failed',reason:'unavailable'}},now);
 const input={clientRef:'binding',runId:run.runId,scope:{kind:'wait'},principalConflict:'unknown',dominantSide:'unknown',mechanismHypothesis:'unknown',alternativeExplanations:[],supportRefs:[],counterRefs:[],unknowns:['unknown'],invalidationConditions:['unknown'],reviewAfter:null,conclusion:'wait',reason:'unknown',reasons:{returnMechanism:'unknown',currentConditions:'unknown',evidenceUnknowns:'unknown',invalidation:'unknown',costRisk:'unknown'},priorRecordId:null};
 const record=createMethodRecord(db,input,now);
 db.prepare('UPDATE research_runs SET decision = ? WHERE id = ?').run(JSON.stringify({finalDecision:'skip',draftCards:[]}),run.runId);
 assert.throws(()=>getMethodRecord(db,record.id)); assert.throws(()=>createMethodRecord(db,input,now)); db.close();
});

test('broad research tracks method gaps separately for multiple candidate drafts', async () => {
 const {adversaryReport,fundamentalsReport,marketStructureReport,quantReport,synthesisReport}=await import('../helpers/research-fixtures.ts');
 const {getRun}=await import('../../src/research/research-service.ts');
 const db=openDb(':memory:'); const scan=await seedBundle(db); const ref=scan.candidates.find(c=>c.instId==='GOOD-USDT')!.snapshotEvidenceId;
 const run=startResearch(db,{bundleId:scan.bundleId,agentMode:'serial_degraded',methodContext:{schemaVersion:1,methodVersion:'v1',instrument:null,product:null,observationResolution:null,evaluationHorizon:null}},now);
 const reports={market_structure:marketStructureReport(ref),fundamentals_events:fundamentalsReport(ref),quant_validation:quantReport(ref),adversary:adversaryReport(ref),synthesis:synthesisReport(ref,{candidates:[{instId:'GOOD-USDT',product:'spot',direction:'long'},{instId:'GOOD-USDT-SWAP',product:'usdt_perpetual',direction:'long'}]})};
 for(let phase=0;phase<3;phase++) for(const task of nextTasks(db,run.runId)) completeTask(db,{assignmentId:task.assignmentId,outcome:{kind:'report',report:reports[task.role]}},now);
 const view=getRun(db,run.runId); const cards=view.decision!.draftCards; assert.equal(cards.length,2); assert.deepEqual(view.missingMethodScopes,cards.map(c=>c.draftId));
 const base={clientRef:'one',runId:run.runId,scope:{kind:'candidate',draftId:cards[0]!.draftId},principalConflict:'unknown',dominantSide:'unknown',mechanismHypothesis:'unknown',alternativeExplanations:[],supportRefs:[],counterRefs:[],unknowns:['unknown'],invalidationConditions:['unknown'],reviewAfter:null,conclusion:'candidate',reason:'unknown',reasons:{returnMechanism:'unknown',currentConditions:'unknown',evidenceUnknowns:'unknown',invalidation:'unknown',costRisk:'unknown'},priorRecordId:null};
 createMethodRecord(db,base,now); assert.deepEqual(getRun(db,run.runId).missingMethodScopes,[cards[1]!.draftId]); assert.equal(getRun(db,run.runId).methodRecordGap,true);
 createMethodRecord(db,{...base,clientRef:'two',scope:{kind:'candidate',draftId:cards[1]!.draftId}},now); assert.deepEqual(getRun(db,run.runId).missingMethodScopes,[]); assert.equal(getRun(db,run.runId).methodRecordGap,false); db.close();
});
