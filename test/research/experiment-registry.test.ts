import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../../src/store/db.ts';
import { createExperimentRegistry } from '../../src/research/experiment-registry.ts';
import { expectDomainError } from '../helpers/assertions.ts';

const now=()=>new Date('2026-01-01T00:00:00.000Z');
const input={experimentId:'experiment:synthetic',version:1,attemptId:'attempt:one',
 strategy:{id:'strategy:synthetic',version:1,entryRules:'synthetic entry',exitRules:'synthetic exit',invalidationRules:'synthetic invalidation'},
 data:{reference:'history:synthetic',sha256:'a'.repeat(64),version:'v1'},code:{reference:'code:synthetic',sha256:'b'.repeat(64),version:'v1'},
 costs:{fees:'synthetic fee assumption',spread:'synthetic spread assumption',slippage:'synthetic slippage assumption',funding:'unknown',execution:'synthetic execution assumption'},
 windows:{exploration:{start:'2025-01-01T00:00:00Z',end:'2025-02-01T00:00:00Z'},validation:{start:'2025-02-01T00:00:00Z',end:'2025-03-01T00:00:00Z'},evaluation:{start:'2025-03-01T00:00:00Z',end:'2025-04-01T00:00:00Z'}},
 evaluation:{metrics:'synthetic metrics',thresholds:'synthetic threshold',baseline:'synthetic baseline',method:'synthetic method'}};
test('preregistration freezes content and does not assert data or strategy validity',()=>{
 const db=openDb(':memory:'); try {const r=createExperimentRegistry(db,now); const saved=r.register(input);
 assert.equal(saved.status,'unvalidated'); assert.equal(saved.dataAvailability,'unverified'); assert.equal(saved.executionAuthorized,false);
 assert.deepEqual(r.register(input),saved); assert.deepEqual(r.get(input.experimentId,1),saved);
 assert.throws(()=>r.register({...input,costs:{...input.costs,fees:'changed'}}));
 } finally {db.close()}
});
test('strict inputs, temporal partitions, and versions reject malformed or conflicting registrations',()=>{
 const db=openDb(':memory:'); try {const r=createExperimentRegistry(db,now);
 for(const x of [{...input,approved:true},{...input,version:0},{...input,data:{...input.data,sha256:'bad'}},{...input,windows:{...input.windows,validation:input.windows.exploration}},{...input,costs:{...input.costs,fees:''}},{...input,version:2},Object.defineProperty({...input},'attemptId',{enumerable:true,get(){throw Error('sentinel')}})]) assert.throws(()=>r.register(x));
 r.register(input); assert.throws(()=>r.register({...input,version:2}));
 const second=r.register({...input,version:2,attemptId:'attempt:two',evaluation:{...input.evaluation,thresholds:'new threshold'}}); assert.equal(second.version,2);
 assert.throws(()=>r.register({...input,experimentId:'experiment:other'}));
 } finally {db.close()}
});
test('append-only records, rollback, integrity and privacy',()=>{
 const db=openDb(':memory:'); try {const r=createExperimentRegistry(db,now);r.register(input);
 for(const sql of ['UPDATE experiment_preregistrations SET version=version','DELETE FROM experiment_preregistrations','INSERT OR REPLACE INTO experiment_preregistrations SELECT * FROM experiment_preregistrations']) assert.throws(()=>db.exec(sql));
 db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON experiment_preregistrations BEGIN SELECT RAISE(ABORT,'private-sentinel'); END");
 assert.throws(()=>r.register({...input,version:2,attemptId:'attempt:two'}),(e:unknown)=>{assert.doesNotMatch(String(e)+JSON.stringify(e),/sentinel/);return true});
 assert.equal(r.get(input.experimentId,2),null);
 db.exec("DROP TRIGGER synthetic_fail; DROP TRIGGER experiment_preregistrations_no_update; UPDATE experiment_preregistrations SET content_sha256='corrupt'");
 expectDomainError(()=>r.get(input.experimentId,1),'PERSISTENCE_UNAVAILABLE');
 } finally {db.close()}
});

test('database failures are distinguished from invalid registration input',()=>{
 const db=openDb(':memory:'); try {const r=createExperimentRegistry(db,now);
 expectDomainError(()=>r.register({...input,version:0}),'INVALID_INPUT');
 db.exec("CREATE TRIGGER synthetic_storage_failure BEFORE INSERT ON experiment_preregistrations BEGIN SELECT RAISE(ABORT,'private-sentinel'); END");
 expectDomainError(()=>r.register(input),'PERSISTENCE_UNAVAILABLE');
 assert.equal(r.get(input.experimentId,1),null);
 } finally {db.close()}
});

test('a strategy id and version cannot name different rules across experiments',()=>{
 const db=openDb(':memory:'); try {const r=createExperimentRegistry(db,now); r.register(input);
 assert.throws(()=>r.register({...input,experimentId:'experiment:other',attemptId:'attempt:other',strategy:{...input.strategy,entryRules:'changed'}}));
 assert.throws(()=>r.register({...input,version:2,attemptId:'attempt:two',strategy:{...input.strategy,entryRules:'changed'}}));
 assert.equal(r.register({...input,version:2,attemptId:'attempt:three',strategy:{...input.strategy,version:2,entryRules:'changed'}}).version,2);
 } finally {db.close()}
});

test('strict JSON rejects hidden or extra input without echoing it',()=>{
 const db=openDb(':memory:'); try { const r=createExperimentRegistry(db,now);
 const secret=Object.defineProperty({...input},'hidden',{value:'private-sentinel',enumerable:false});
 const extra=JSON.parse(JSON.stringify(input).replace('"attemptId":','"__proto__":{},"attemptId":'));
 for(const x of [secret,extra,{...input,data:{...input.data,accessToken:'private-sentinel'}}]) assert.throws(()=>r.register(x),(e:unknown)=>{assert.doesNotMatch(String(e)+JSON.stringify(e),/sentinel|accessToken/);return true});
 } finally {db.close()}
});

test('separate SQLite connections share attempt uniqueness and respect locks',async(t)=>{
 const {mkdtempSync,realpathSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {isAbsolute,join,relative}=await import('node:path');
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'experiment-'))); const within=relative(realpathSync(tmpdir()),dir); assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
 let one:Db|undefined;let two:Db|undefined;
 t.after(()=>{if(one?.isTransaction) one.exec('ROLLBACK');one?.close();two?.close();rmSync(dir,{recursive:true,force:true})});
 const path=join(dir,'synthetic.sqlite');one=openDb(path);two=openDb(path);
 const a=createExperimentRegistry(one,now);const b=createExperimentRegistry(two,now);const first=a.register(input);assert.deepEqual(b.register(input),first);
 assert.throws(()=>b.register({...input,experimentId:'experiment:other'}));
 two.exec('PRAGMA busy_timeout=0');one.exec('BEGIN IMMEDIATE');assert.throws(()=>b.register({...input,version:2,attemptId:'attempt:two'}));one.exec('ROLLBACK');
 assert.equal(b.register({...input,version:2,attemptId:'attempt:two'}).status,'unvalidated');
 for(const t of ['experiment_strategy_versions','experiment_preregistrations']) for(const sql of [`UPDATE ${t} SET rowid=rowid`,`DELETE FROM ${t}`,`INSERT OR REPLACE INTO ${t} SELECT * FROM ${t}`]) assert.throws(()=>one.exec(sql));
});

