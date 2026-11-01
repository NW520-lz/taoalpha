import { z } from 'zod';
import { parseConfirmationProposal } from '../control/confirmation-schema.ts';
import { DomainError } from '../lib/errors.ts';
import { canonicalJson, sha256 } from '../lib/hash.ts';
import { getRow, inTransaction, type Db } from '../store/db.ts';
import { dec } from '../lib/decimal.ts';
import { evaluationGatesSchema } from './gates.ts';
import { fundingMatchesProduct, trendReplayConfigSchema } from './trend-replay.ts';

const reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const text=z.string().min(1).max(2000).refine(v=>v.trim()===v && v.length>0);
const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const source=z.strictObject({reference,sha256:hash,version:reference});
export const historyScopeSchema=z.strictObject({site:z.enum(['global','eea','us','tr']),instId:z.string().regex(/^[A-Z0-9]+-USDT(?:-SWAP)?$/),product:z.enum(['spot','usdt_perpetual']),resolution:z.enum(['1m','5m','15m','1H','4H','1Dutc'])})
 .refine(v=>v.product==='spot'?!v.instId.endsWith('-SWAP'):v.instId.endsWith('-SWAP'));
const dataSource=source.extend({scope:historyScopeSchema.optional()});
// A multi-instrument universe: every member is a frozen manifest reference with its own scope.
const label=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
const universeSchema=z.strictObject({
 instruments:z.array(z.strictObject({group:label,data:source.extend({scope:historyScopeSchema})})).min(2).max(200),
 regimes:z.array(z.strictObject({label,start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true})})).min(1).max(20).optional(),
});
const window=z.strictObject({start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true})});
const schema=z.strictObject({experimentId:reference,version,attemptId:reference,
 strategy:z.strictObject({id:reference,version,entryRules:text,exitRules:text,invalidationRules:text}),
 data:dataSource,code:source,
 costs:z.strictObject({fees:text,spread:text,slippage:text,funding:text,execution:text}),
 windows:z.strictObject({exploration:window,validation:window,evaluation:window}),
 evaluation:z.strictObject({metrics:text,thresholds:text,baseline:text,method:text}),
 replay:trendReplayConfigSchema.optional(),
 gates:evaluationGatesSchema.optional(),
 universe:universeSchema.optional()
}).refine(v=>{const {exploration:a,validation:b,evaluation:c}=v.windows; const t=[a.start,a.end,b.start,b.end,c.start,c.end].map(Date.parse); return t.every(Number.isFinite) && t[0]!<t[1]! && t[1]!<=t[2]! && t[2]!<t[3]! && t[3]!<=t[4]! && t[4]!<t[5]!})
 .refine(v=>v.replay===undefined || (v.data.scope?.product===v.replay.market.product && fundingMatchesProduct(v.replay)))
 .refine(v=>v.gates===undefined || v.replay!==undefined)
 // Universe members differ only by instrument, and regimes are ordered, non-overlapping periods.
 .refine(v=>!v.universe || (v.replay!==undefined && v.data.scope!==undefined
  && new Set(v.universe.instruments.map(i=>i.data.scope.instId)).size===v.universe.instruments.length
  && v.universe.instruments.every(i=>i.data.scope.site===v.data.scope!.site && i.data.scope.product===v.data.scope!.product && i.data.scope.resolution===v.data.scope!.resolution)
  && (v.universe.regimes ?? []).every((r,k,all)=>Date.parse(r.start)<Date.parse(r.end) && (k===0 || Date.parse(all[k-1]!.end)<=Date.parse(r.start)))))
 // Stressed costs must stay a valid share of notional (at most 100% per side).
 // Every sensitivity neighbourhood is centred on the registered parameter value.
 .refine(v=>!v.gates?.sensitivity || !v.replay || Object.entries(v.gates.sensitivity.neighbourhoods).every(([key,values])=>{const registered=v.replay!.rule[key as 'atrPeriod'];return (values as Array<number|string>).some(x=>typeof x==='number' ? x===registered : dec(x).eq(String(registered)));}))
 .refine(v=>!v.gates?.costStressMultipliers || !v.replay || Math.max(...Object.values(v.replay.cost).filter((c):c is number=>typeof c==='number'))*Math.max(...v.gates.costStressMultipliers)<=1000000);
type Input=z.infer<typeof schema>;
export type ExperimentRegistration=Input & {schemaVersion:1|2|3;registeredAt:string;contentSha256:string;status:'unvalidated';dataAvailability:'unverified';executionAuthorized:false};
interface Row {experiment_id:string;version:number;attempt_id:string;content:string;content_sha256:string}
function fail(code:'INVALID_INPUT'|'IDEMPOTENCY_CONFLICT'|'PERSISTENCE_UNAVAILABLE'='INVALID_INPUT'):never {throw new DomainError(code,'Experiment registration rejected',[{ruleId:'experiment.registration'}])}
function safe<T>(fn:()=>T):T {
 try{return fn()}catch(e){
  if(e instanceof DomainError && e.message==='Experiment registration rejected') throw e;
  if(e instanceof Error && 'code' in e && (e.code==='ERR_SQLITE_ERROR' || e.code==='ERR_INVALID_STATE')) return fail('PERSISTENCE_UNAVAILABLE');
  return fail();
 }
}
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
  try { return parseStoredRow(row); } catch { return fail('PERSISTENCE_UNAVAILABLE'); }
 }
 function parseStoredRow(row:Row):ExperimentRegistration {
  const parsed=JSON.parse(row.content) as ExperimentRegistration;
  const {contentSha256,...body}=parsed;
  if(canonicalJson(parsed)!==row.content || contentSha256!==row.content_sha256 || sha256(canonicalJson(body))!==contentSha256 || parsed.experimentId!==row.experiment_id || parsed.version!==row.version || parsed.attemptId!==row.attempt_id || parsed.status!=='unvalidated' || parsed.dataAvailability!=='unverified' || parsed.executionAuthorized!==false || !((parsed.schemaVersion===1 && parsed.data?.scope===undefined && parsed.replay===undefined && parsed.gates===undefined && parsed.universe===undefined)||(parsed.schemaVersion===2 && parsed.data?.scope!==undefined && parsed.replay===undefined && parsed.gates===undefined && parsed.universe===undefined)||(parsed.schemaVersion===3 && parsed.data?.scope!==undefined && parsed.replay!==undefined))) fail();
  const {schemaVersion,registeredAt,status,dataAvailability,executionAuthorized,...input}=body;
  const strategy=getRow<{content:string}>(db,'SELECT content FROM experiment_strategy_versions WHERE strategy_id=? AND version=?',input.strategy.id,input.strategy.version);
  if(!schema.safeParse(input).success || !Number.isFinite(Date.parse(registeredAt)) || !strategy || strategy.content!==canonicalJson(input.strategy)) fail();
  return parsed;
 }
 return {
  register(raw:unknown):ExperimentRegistration {return safe(()=>{const input=readInput(raw); return inTransaction(db,()=>{
   const row=getRow<Row>(db,'SELECT * FROM experiment_preregistrations WHERE (experiment_id=? AND version=?) OR attempt_id=?',input.experimentId,input.version,input.attemptId);
   if(row){const old=parseRow(row); const {schemaVersion,registeredAt,contentSha256,status,dataAvailability,executionAuthorized,...original}=old; if(canonicalJson(original)!==canonicalJson(input)) fail('IDEMPOTENCY_CONFLICT'); return old;}
   if(!input.data.scope) fail();
   const latest=getRow<{version:number}>(db,'SELECT version FROM experiment_preregistrations WHERE experiment_id=? ORDER BY version DESC LIMIT 1',input.experimentId);
   if(input.version!==(latest ? latest.version+1 : 1)) fail('IDEMPOTENCY_CONFLICT');
   const priorStrategy=getRow<{content:string}>(db,'SELECT content FROM experiment_strategy_versions WHERE strategy_id=? AND version=?',input.strategy.id,input.strategy.version);
   const strategyContent=canonicalJson(input.strategy);
   if(priorStrategy && priorStrategy.content!==strategyContent) fail('IDEMPOTENCY_CONFLICT');
   if(!priorStrategy) db.prepare('INSERT INTO experiment_strategy_versions VALUES(?,?,?)').run(input.strategy.id,input.strategy.version,strategyContent);
   const date=now(); if(!(date instanceof Date)||!Number.isFinite(date.getTime())) fail();
   // Schema 3 = schema 2 plus machine-readable replay parameters (and optional gates) bound into the content hash.
   const body={...input,schemaVersion:input.replay ? 3 as const : 2 as const,registeredAt:date.toISOString(),status:'unvalidated' as const,dataAvailability:'unverified' as const,executionAuthorized:false as const};
   const record={...body,contentSha256:sha256(canonicalJson(body))};
   db.prepare('INSERT INTO experiment_preregistrations VALUES(?,?,?,?,?)').run(input.experimentId,input.version,input.attemptId,canonicalJson(record),record.contentSha256);
   return record;
  })})},
  get(experimentId:string,requestedVersion:number):ExperimentRegistration|null {return safe(()=>{if(!reference.safeParse(experimentId).success||!version.safeParse(requestedVersion).success) fail(); const row=getRow<Row>(db,'SELECT * FROM experiment_preregistrations WHERE experiment_id=? AND version=?',experimentId,requestedVersion); return row?parseRow(row):null})}
 };
}

