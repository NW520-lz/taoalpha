import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { seedBundle,marketStructureReport } from '../helpers/research-fixtures.ts';
import { NOW } from '../helpers/market-fixtures.ts';
import { startResearch,nextTasks,completeTask,listSubmissionConflicts } from '../../src/research/research-service.ts';
const now=()=>NOW;
test('conflicts persist once, stay blind until phase close, never modify evidence',async()=>{
 const db=openDb(':memory:'); const scan=await seedBundle(db); const run=startResearch(db,{bundleId:scan.bundleId,agentMode:'serial_degraded'},now); const tasks=nextTasks(db,run.runId); const task=tasks[0]!; const ref=scan.candidates[0]!.snapshotEvidenceId;
 const original={kind:'report' as const,report:marketStructureReport(ref)}; completeTask(db,{assignmentId:task.assignmentId,outcome:original},now);
 const changed={kind:'report' as const,report:{...marketStructureReport(ref),summary:'untrusted conflict'}};
 assert.throws(()=>completeTask(db,{assignmentId:task.assignmentId,outcome:changed},now)); assert.throws(()=>completeTask(db,{assignmentId:task.assignmentId,outcome:changed},now));
 assert.deepEqual(listSubmissionConflicts(db,run.runId),[]);
 for(const other of tasks.slice(1)) completeTask(db,{assignmentId:other.assignmentId,outcome:{kind:'failed',reason:'unavailable'}},now);
 const rows=listSubmissionConflicts(db,run.runId); assert.equal(rows.length,1); assert.equal(rows[0]?.classification,'conflicting_submission'); assert.equal(rows[0]?.timeout,'unknown_no_deadline'); assert.ok(!JSON.stringify(rows).includes('untrusted conflict'));
 assert.throws(()=>db.exec("UPDATE research_submission_conflicts SET payload_sha256 = 'x'"),/immutable/); assert.throws(()=>db.exec('DELETE FROM research_submission_conflicts'),/immutable/);
 db.close();
});

test('conflict write rolls back on failure and tampering is detected',async()=>{
 const db=openDb(':memory:'); const scan=await seedBundle(db); const run=startResearch(db,{bundleId:scan.bundleId,agentMode:'serial_degraded'},now); const tasks=nextTasks(db,run.runId); const task=tasks[0]!;
 completeTask(db,{assignmentId:task.assignmentId,outcome:{kind:'failed',reason:'first'}},now);
 db.exec("CREATE TRIGGER fail_conflict BEFORE INSERT ON research_submission_conflicts BEGIN SELECT RAISE(ABORT, 'injected'); END");
 assert.throws(()=>completeTask(db,{assignmentId:task.assignmentId,outcome:{kind:'failed',reason:'second'}},now)); assert.equal((db.prepare('SELECT count(*) AS n FROM research_submission_conflicts').get() as {n:number}).n,0);
 db.exec('DROP TRIGGER fail_conflict'); assert.throws(()=>completeTask(db,{assignmentId:task.assignmentId,outcome:{kind:'failed',reason:'second'}},now));
 for(const t of tasks.slice(1)) completeTask(db,{assignmentId:t.assignmentId,outcome:{kind:'failed',reason:'unavailable'}},now);
 assert.throws(()=>db.exec('INSERT OR REPLACE INTO research_submission_conflicts SELECT * FROM research_submission_conflicts'));
 db.exec('DROP TRIGGER submission_conflicts_no_update'); db.exec("UPDATE research_submission_conflicts SET payload_sha256 = 'tampered'"); assert.throws(()=>listSubmissionConflicts(db,run.runId)); db.close();
});

test('decided run rejects oversized conflicts without changing decision or evidence',async()=>{
 const {getRun}=await import('../../src/research/research-service.ts'); const db=openDb(':memory:'); const scan=await seedBundle(db); const run=startResearch(db,{bundleId:scan.bundleId,agentMode:'serial_degraded'},now); const first=nextTasks(db,run.runId)[0]!;
 while(nextTasks(db,run.runId).length) for(const task of nextTasks(db,run.runId)) completeTask(db,{assignmentId:task.assignmentId,outcome:{kind:'failed',reason:'unavailable'}},now);
 const before=getRun(db,run.runId); const evidence=(db.prepare('SELECT count(*) AS n FROM evidence_items').get() as {n:number}).n;
 assert.throws(()=>completeTask(db,{assignmentId:first.assignmentId,outcome:{kind:'failed',reason:'x'.repeat(40000)}},now)); assert.equal((db.prepare('SELECT count(*) AS n FROM research_submission_conflicts').get() as {n:number}).n,0);
 assert.throws(()=>completeTask(db,{assignmentId:first.assignmentId,outcome:{kind:'failed',reason:'other'}},now)); const after=getRun(db,run.runId);
 assert.deepEqual(after.decision,before.decision); assert.deepEqual(after.reports,before.reports); assert.equal((db.prepare('SELECT count(*) AS n FROM evidence_items').get() as {n:number}).n,evidence); db.close();
});
