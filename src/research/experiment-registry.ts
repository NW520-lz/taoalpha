import { z } from 'zod';
import { parseConfirmationProposal } from '../control/confirmation-schema.ts';
import { DomainError } from '../lib/errors.ts';
import { canonicalJson, sha256 } from '../lib/hash.ts';
import { getRow, inTransaction, type Db } from '../store/db.ts';

const reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const text=z.string().min(1).max(2000).refine(v=>v.trim()===v && v.length>0);
const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const source=z.strictObject({reference,sha256:hash,version:reference});
const window=z.strictObject({start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true})});
const schema=z.strictObject({experimentId:reference,version,attemptId:reference,
 strategy:z.strictObject({id:reference,version,entryRules:text,exitRules:text,invalidationRules:text}),
 data:source,code:source,
 costs:z.strictObject({fees:text,spread:text,slippage:text,funding:text,execution:text}),
 windows:z.strictObject({exploration:window,validation:window,evaluation:window}),
 evaluation:z.strictObject({metrics:text,thresholds:text,baseline:text,method:text})
}).refine(v=>{const {exploration:a,validation:b,evaluation:c}=v.windows; const t=[a.start,a.end,b.start,b.end,c.start,c.end].map(Date.parse); return t.every(Number.isFinite) && t[0]!<t[1]! && t[1]!<=t[2]! && t[2]!<t[3]! && t[3]!<=t[4]! && t[4]!<t[5]!});
type Input=z.infer<typeof schema>;
export type ExperimentRegistration=Input & {schemaVersion:1;registeredAt:string;contentSha256:string;status:'unvalidated';dataAvailability:'unverified';executionAuthorized:false};
interface Row {experiment_id:string;version:number;attempt_id:string;content:string;content_sha256:string}
function fail(code:'INVALID_INPUT'|'IDEMPOTENCY_CONFLICT'|'PERSISTENCE_UNAVAILABLE'='INVALID_INPUT'):never {throw new DomainError(code,'Experiment registration rejected',[{ruleId:'experiment.registration'}])}
function safe<T>(fn:()=>T):T {try{return fn()}catch(e){if(e instanceof DomainError && e.message==='Experiment registration rejected') throw e; return fail()}}
function readInput(raw:unknown):Input {
 // The existing JSON envelope rejects accessors, prototypes, non-JSON values and unsafe keys before Zod can project them.
 const checked=parseConfirmationProposal({requestRef:'input',subject:{version:1,kind:'risk_policy',scopeId:'scope:input',accountRef:'account:input',site:'global',environment:'demo',payload:{input:raw},expiresAt:'2099-01-01T00:00:00Z'}}).subject.payload.input;
 const result=schema.safeParse(checked); if(!result.success || canonicalJson(checked)!==canonicalJson(result.data)) fail(); return result.data;
}
const DDL=[
 `CREATE TABLE IF NOT EXISTS experiment_strategy_versions (strategy_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(strategy_id,version))`,
 `CREATE TRIGGER IF NOT EXISTS experiment_strategy_versions_no_update BEFORE UPDATE ON experiment_strategy_versions BEGIN SELECT RAISE(ABORT,'immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS experiment_strategy_versions_no_delete BEFORE DELETE ON experiment_strategy_versions BEGIN SELECT RAISE(ABORT,'immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS experiment_strategy_versions_no_replace BEFORE INSERT ON experiment_strategy_versions WHEN EXISTS(SELECT 1 FROM experiment_strategy_versions WHERE strategy_id=NEW.strategy_id AND version=NEW.version) BEGIN SELECT RAISE(ABORT,'immutable'); END`,
 `CREATE TABLE IF NOT EXISTS experiment_preregistrations (experiment_id TEXT NOT NULL, version INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, content_sha256 TEXT NOT NULL, PRIMARY KEY(experiment_id,version))`,
 `CREATE TRIGGER IF NOT EXISTS experiment_preregistrations_no_update BEFORE UPDATE ON experiment_preregistrations BEGIN SELECT RAISE(ABORT,'immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS experiment_preregistrations_no_delete BEFORE DELETE ON experiment_preregistrations BEGIN SELECT RAISE(ABORT,'immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS experiment_preregistrations_no_replace BEFORE INSERT ON experiment_preregistrations WHEN EXISTS(SELECT 1 FROM experiment_preregistrations WHERE (experiment_id=NEW.experiment_id AND version=NEW.version) OR attempt_id=NEW.attempt_id) BEGIN SELECT RAISE(ABORT,'immutable'); END`,
];
/** Internal research-only storage. Registrations do not verify inputs or authorize trading. */
export function createExperimentRegistry(db:Db,now:()=>Date) {
 safe(()=>inTransaction(db,()=>{for(const sql of DDL) db.exec(sql)}));
 function parseRow(row:Row):ExperimentRegistration {
  const parsed=JSON.parse(row.content) as ExperimentRegistration;
  const {contentSha256,...body}=parsed;
  if(canonicalJson(parsed)!==row.content || contentSha256!==row.content_sha256 || sha256(canonicalJson(body))!==contentSha256 || parsed.experimentId!==row.experiment_id || parsed.version!==row.version || parsed.attemptId!==row.attempt_id || parsed.status!=='unvalidated' || parsed.dataAvailability!=='unverified' || parsed.executionAuthorized!==false || parsed.schemaVersion!==1) fail();
  const {schemaVersion,registeredAt,status,dataAvailability,executionAuthorized,...input}=body;
  const strategy=getRow<{content:string}>(db,'SELECT content FROM experiment_strategy_versions WHERE strategy_id=? AND version=?',input.strategy.id,input.strategy.version);
  if(!schema.safeParse(input).success || !Number.isFinite(Date.parse(registeredAt)) || !strategy || strategy.content!==canonicalJson(input.strategy)) fail();
  return parsed;
 }
 return {
  register(raw:unknown):ExperimentRegistration {return safe(()=>{const input=readInput(raw); return inTransaction(db,()=>{
   const row=getRow<Row>(db,'SELECT * FROM experiment_preregistrations WHERE (experiment_id=? AND version=?) OR attempt_id=?',input.experimentId,input.version,input.attemptId);
   if(row){const old=parseRow(row); const {schemaVersion,registeredAt,contentSha256,status,dataAvailability,executionAuthorized,...original}=old; if(canonicalJson(original)!==canonicalJson(input)) fail('IDEMPOTENCY_CONFLICT'); return old;}
   const latest=getRow<{version:number}>(db,'SELECT version FROM experiment_preregistrations WHERE experiment_id=? ORDER BY version DESC LIMIT 1',input.experimentId);
   if(input.version!==(latest ? latest.version+1 : 1)) fail('IDEMPOTENCY_CONFLICT');
   const priorStrategy=getRow<{content:string}>(db,'SELECT content FROM experiment_strategy_versions WHERE strategy_id=? AND version=?',input.strategy.id,input.strategy.version);
   const strategyContent=canonicalJson(input.strategy);
   if(priorStrategy && priorStrategy.content!==strategyContent) fail('IDEMPOTENCY_CONFLICT');
   if(!priorStrategy) db.prepare('INSERT INTO experiment_strategy_versions VALUES(?,?,?)').run(input.strategy.id,input.strategy.version,strategyContent);
   const date=now(); if(!(date instanceof Date)||!Number.isFinite(date.getTime())) fail();
   const body={...input,schemaVersion:1 as const,registeredAt:date.toISOString(),status:'unvalidated' as const,dataAvailability:'unverified' as const,executionAuthorized:false as const};
   const record={...body,contentSha256:sha256(canonicalJson(body))};
   db.prepare('INSERT INTO experiment_preregistrations VALUES(?,?,?,?,?)').run(input.experimentId,input.version,input.attemptId,canonicalJson(record),record.contentSha256);
   return record;
  })})},
  get(experimentId:string,requestedVersion:number):ExperimentRegistration|null {return safe(()=>{if(!reference.safeParse(experimentId).success||!version.safeParse(requestedVersion).success) fail(); const row=getRow<Row>(db,'SELECT * FROM experiment_preregistrations WHERE experiment_id=? AND version=?',experimentId,requestedVersion); return row?parseRow(row):null})}
 };
}

