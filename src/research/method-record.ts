import { z } from 'zod';
import { DomainError } from '../lib/errors.ts';
import { hashJson } from '../lib/hash.ts';
import { newId } from '../lib/ids.ts';
import { allRows, getRow, inTransaction, type Db } from '../store/db.ts';
import { getBundle, getEvidence, type StoredBundle } from '../store/evidence-store.ts';
import type { ScanContent } from '../scan/scan.ts';
import type { Decision } from './decision.ts';

const text = z.string().trim().min(1).max(2000);
const nullableText = text.nullable();
export const methodContextSchema = z.object({ schemaVersion:z.literal(1), methodVersion:text, instrument:nullableText, product:z.enum(['spot','usdt_perpetual']).nullable(), observationResolution:nullableText, evaluationHorizon:nullableText }).strict();
export type MethodContextInput = z.infer<typeof methodContextSchema>;
export type FrozenMethodContext = MethodContextInput & { bundle: {id:string; sha256:string}; scanConfiguration: ScanContent['strategy']; strategyValidation: 'unverified' };
const ref = z.object({id:text, sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const reasonClaim = z.discriminatedUnion('kind', [
 z.object({kind:z.literal('observation'),text,refs:z.array(ref).min(1).max(20)}).strict(),
 z.object({kind:z.literal('inference'),text,refs:z.array(ref).max(20)}).strict(),
 z.object({kind:z.literal('unknown'),text,refs:z.array(ref).max(20)}).strict(),
]);
const reasonClaims = z.array(reasonClaim).min(1).max(20);
const reasonEvidence = z.object({returnMechanism:reasonClaims,currentConditions:reasonClaims,evidenceUnknowns:reasonClaims,invalidation:reasonClaims,costRisk:reasonClaims}).strict();
export const methodRecordSchema = z.object({
 clientRef:text, runId:text, scope:z.discriminatedUnion('kind', [z.object({kind:z.literal('candidate'), draftId:text}).strict(), z.object({kind:z.enum(['wait','skip'])}).strict()]),
 principalConflict:text, dominantSide:text, mechanismHypothesis:text, alternativeExplanations:z.array(text), supportRefs:z.array(ref), counterRefs:z.array(ref), unknowns:z.array(text), invalidationConditions:z.array(text), reviewAfter:z.iso.datetime({offset:true}).nullable(), conclusion:text, reason:text,
 reasons:z.object({returnMechanism:text,currentConditions:text,evidenceUnknowns:text,invalidation:text,costRisk:text}).strict(), reasonEvidence:reasonEvidence.optional(), priorRecordId:text.nullable(),
}).strict();
export type MethodRecordInput = z.infer<typeof methodRecordSchema>;
export type MethodRecord = MethodRecordInput & { id:string; schemaVersion:1|2; createdAt:string; bundle:{id:string;sha256:string}; methodVersion:string; decisionSha256:string; contentSha256:string; interpretationStatus:'unverified'; mechanismHypothesisKind:'inference'; executable:false };
const invalid = (ruleId:string): never => { throw new DomainError('INVALID_INPUT', 'Research method input or evidence is invalid.', [{ruleId}]); };
function parse<T>(schema:z.ZodType<T>, value:unknown):T { const r=schema.safeParse(value); return r.success ? r.data : invalid('research.method_schema'); }
export function parseMethodContext(input:unknown,bundle:StoredBundle):FrozenMethodContext {
 const context=parse(methodContextSchema,input); const scan=bundle.content as ScanContent;
 if (hashJson(bundle.content)!==bundle.contentSha256 || !scan.strategy) return invalid('research.bundle_hash');
 if ((context.instrument === null) !== (context.product === null)) return invalid('research.method_scope');
 if (context.instrument && !scan.candidates.some(c=>c.instId===context.instrument && c.product===context.product)) return invalid('research.method_scope');
 return {...context,bundle:{id:bundle.id,sha256:bundle.contentSha256},scanConfiguration:scan.strategy,strategyValidation:'unverified'};
}
export function getMethodContext(db:Db,runId:string):FrozenMethodContext|null {
 const row=getRow<{content:string;content_sha256:string}>(db,'SELECT content, content_sha256 FROM research_method_contexts WHERE run_id = ?',runId);
 if (!row) return null; const value=JSON.parse(row.content) as FrozenMethodContext;
 if(hashJson(value)!==row.content_sha256) return invalid('research.method_hash');
 const bundle=getBundle(db,value.bundle.id); if(!bundle || bundle.contentSha256!==value.bundle.sha256 || hashJson(bundle.content)!==value.bundle.sha256) return invalid('research.bundle_hash');
 const run=getRow<{bundle_id:string;bundle_sha256:string}>(db,'SELECT bundle_id,bundle_sha256 FROM research_runs WHERE id = ?',runId);
 if(!run || run.bundle_id!==value.bundle.id || run.bundle_sha256!==value.bundle.sha256) return invalid('research.bundle_hash');
 return value;
}
export function createMethodRecord(db:Db, raw:unknown, now:()=>Date):MethodRecord {
 const input=parse(methodRecordSchema,raw);
 return inTransaction(db,()=>{
  const context=getMethodContext(db,input.runId); if(!context) return invalid('research.method_context_missing');
  const run=getRow<{decision:string|null}>(db,'SELECT decision FROM research_runs WHERE id = ?',input.runId); if(!run?.decision) return invalid('research.decision_missing');
  const decision=JSON.parse(run.decision) as Decision;
  const seal=getRow<{decision_sha256:string}>(db,'SELECT decision_sha256 FROM research_decision_seals WHERE run_id = ?',input.runId);
  if(!seal || seal.decision_sha256!==hashJson(decision)) return invalid('research.decision_hash');
  const scope=input.scope;
  if(scope.kind==='candidate' ? !decision.draftCards.some(c=>c.draftId===scope.draftId && (context.instrument === null || (c.instId===context.instrument && c.product===context.product))) : decision.finalDecision!==scope.kind) return invalid('research.method_scope');
  const existing=getRow<{id:string;content:string}>(db,'SELECT id, content FROM decision_method_records WHERE run_id = ? AND client_ref = ?',input.runId,input.clientRef);
  if(existing) { const stored=getMethodRecord(db,existing.id); const {id, schemaVersion, createdAt, bundle, methodVersion, decisionSha256, contentSha256, interpretationStatus, mechanismHypothesisKind, executable, ...original}=stored; if(hashJson(original)===hashJson(input)) return stored; throw new DomainError('IDEMPOTENCY_CONFLICT','Conflicting record reference.',[{ruleId:'research.method_duplicate'}]); }
  if(input.priorRecordId) { const prior=getMethodRecord(db,input.priorRecordId); if(prior.runId!==input.runId || hashJson(prior.scope)!==hashJson(input.scope)) return invalid('research.method_prior'); }
  const bundle=getBundle(db,context.bundle.id)!; const scan=bundle.content as ScanContent;
  const sources=allRows<{id:string}>(db,"SELECT id FROM evidence_items WHERE submitted_by LIKE ?",`research:${input.runId}:%`).map(r=>r.id);
  const allowed=new Set([...scan.candidates.map(c=>c.snapshotEvidenceId),...sources]);
  const seen=new Map<string,string>();
  for(const r of [...input.supportRefs,...input.counterRefs,...claimRefs(input.reasonEvidence)]) { const prev=seen.get(r.id); if(prev && prev!==r.sha256) return invalid('research.method_refs'); seen.set(r.id,r.sha256); const e=getEvidence(db,r.id); if(!allowed.has(r.id)||!e||e.contentSha256!==r.sha256||hashJson(e.content)!==r.sha256) return invalid('research.method_refs'); }
  const base={...input,id:newId('method'),schemaVersion:input.reasonEvidence ? 2 as const : 1 as const,createdAt:now().toISOString(),bundle:context.bundle,methodVersion:context.methodVersion,decisionSha256:seal.decision_sha256,interpretationStatus:'unverified' as const,mechanismHypothesisKind:'inference' as const,executable:false as const};
  const record={...base,contentSha256:hashJson(base)};
  db.prepare('INSERT INTO decision_method_records VALUES (?, ?, ?, ?, ?)').run(record.id,input.runId,input.clientRef,JSON.stringify(record),record.contentSha256);
  return record;
 });
}
export function getMethodRecord(db:Db,id:string):MethodRecord {
 const row=getRow<{content:string;content_sha256:string}>(db,'SELECT content,content_sha256 FROM decision_method_records WHERE id = ?',id); if(!row) return invalid('research.method_record_missing');
 const record=JSON.parse(row.content) as MethodRecord; const {contentSha256,...base}=record; if(contentSha256!==row.content_sha256 || hashJson(base)!==contentSha256) return invalid('research.method_hash');
 const run=getRow<{decision:string|null}>(db,'SELECT decision FROM research_runs WHERE id = ?',record.runId); const seal=getRow<{decision_sha256:string}>(db,'SELECT decision_sha256 FROM research_decision_seals WHERE run_id = ?',record.runId);
 if(!run?.decision || !seal || seal.decision_sha256!==record.decisionSha256 || hashJson(JSON.parse(run.decision))!==record.decisionSha256) return invalid('research.decision_hash');
 const context=getMethodContext(db,record.runId); if (!context || context.bundle.id!==record.bundle.id || context.bundle.sha256!==record.bundle.sha256 || context.methodVersion!==record.methodVersion) return invalid('research.method_hash');
 const bundle=getBundle(db,record.bundle.id)!; const allowed=new Set([...(bundle.content as ScanContent).candidates.map(c=>c.snapshotEvidenceId),...allRows<{id:string}>(db,"SELECT id FROM evidence_items WHERE submitted_by LIKE ?",`research:${record.runId}:%`).map(r=>r.id)]);
 for(const ref of [...record.supportRefs,...record.counterRefs,...claimRefs(record.reasonEvidence)]) { const e=getEvidence(db,ref.id); if(!allowed.has(ref.id) || !e || e.contentSha256!==ref.sha256 || hashJson(e.content)!==ref.sha256) return invalid('research.method_refs'); }
 return record;
}

function claimRefs(evidence: MethodRecordInput['reasonEvidence']): Array<z.infer<typeof ref>> {
 return evidence ? Object.values(evidence).flatMap(claims => claims.flatMap(claim => claim.refs)) : [];
}
