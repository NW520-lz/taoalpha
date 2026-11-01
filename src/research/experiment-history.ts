import {z} from 'zod';
import {parseConfirmationProposal} from '../control/confirmation-schema.ts';
import {DomainError} from '../lib/errors.ts';
import {hashJson,sha256} from '../lib/hash.ts';
import {getHistory} from '../market/history.ts';
import {historyScopeSchema, type createExperimentRegistry} from './experiment-registry.ts';
import type {Db} from '../store/db.ts';

const ref=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const expectedSchema=historyScopeSchema;
const inputSchema=z.strictObject({experimentId:ref,version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),expected:expectedSchema});
const source=z.object({endpoint:z.string().min(1),receivedAt:z.string().nullable(),status:z.number().int().nullable(),body:z.string().nullable(),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),error:z.string().nullable()}).strict();
const manifestSchema=z.object({schemaVersion:z.literal(1),parsingVersion:z.literal('okx-history-v1'),site:z.enum(['global','eea','us','tr']),request:z.object({instId:z.string(),product:z.enum(['spot','usdt_perpetual']),resolution:z.enum(['1m','5m','15m','1H','4H','1Dutc']),start:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),end:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),asOf:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).passthrough(),sources:z.array(source).max(200),gaps:z.array(z.string().min(1).max(500)),candleCoverage:z.enum(['complete','partial']),availability:z.literal('historical_publication_unverified'),historicalUniverse:z.literal('unknown_survivorship_gap'),funding:z.object({status:z.enum(['not_applicable','unknown'])}).passthrough(),strategyValid:z.literal(false),executionAuthorized:z.literal(false)}).passthrough();
function fail(code:'INVALID_INPUT'|'PERSISTENCE_UNAVAILABLE'='INVALID_INPUT'):never{throw new DomainError(code,'Experiment history inspection rejected',[{ruleId:'experiment.history_inspection'}])}
/** Read-only backend comparison. Registry must be process-owned and use the same db connection. */
export function inspectExperimentHistory(db:Db,registry:Pick<ReturnType<typeof createExperimentRegistry>,'get'>,raw:unknown) {
 try {
  const checked=parseConfirmationProposal({requestRef:'input',subject:{version:1,kind:'risk_policy',scopeId:'scope:input',accountRef:'account:input',site:'global',environment:'demo',payload:{input:raw},expiresAt:'2099-01-01T00:00:00Z'}}).subject.payload.input;
  const result=inputSchema.safeParse(checked);if(!result.success) fail(); const {experimentId,version,expected}=result.data;
  if(db.isTransaction) fail(); db.exec('BEGIN');
  try {
   const registration=registry.get(experimentId,version); if(!registration) fail();
   const data=registration.data;
   const frozenScope=registration.schemaVersion>=2 ? data.scope : undefined;
   if(registration.schemaVersion>=2 && (!frozenScope || hashJson(frozenScope)!==hashJson(expected))) fail();
   if(!/^history_[a-f0-9]{64}$/.test(data.reference) || data.reference!==`history_${data.sha256}` || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_manifests'").get()) fail();
   let rawManifest:ReturnType<typeof getHistory>;
   try { rawManifest=getHistory(db,data.reference); } catch { return fail('PERSISTENCE_UNAVAILABLE'); }
   if(!rawManifest) fail();
   if(hashJson(rawManifest)!==data.sha256) fail('PERSISTENCE_UNAVAILABLE');
   const parsed=manifestSchema.safeParse(rawManifest);if(!parsed.success) fail(); const m=parsed.data;
   if(m.parsingVersion!==data.version || m.site!==expected.site || m.request.instId!==expected.instId || m.request.product!==expected.product || m.request.resolution!==expected.resolution || (m.request.product==='spot' ? m.request.instId.endsWith('-SWAP') : !m.request.instId.endsWith('-SWAP')) || (m.request.product==='spot' ? m.funding.status!=='not_applicable' : m.funding.status!=='unknown')) fail();
   for(const s of m.sources) if((s.body===null)!==(s.sha256===null) || (s.body!==null && sha256(s.body)!==s.sha256)) fail();
   const windows=Object.values(registration.windows);
   if(m.request.start>=m.request.end || m.request.asOf<m.request.end || windows.some(w=>m.request.start>Date.parse(w.start) || m.request.end<Date.parse(w.end))) fail();
   const output={binding:'matched' as const,expectedScopeBinding:frozenScope ? 'registration_bound' as const : 'caller_supplied_unbound' as const,reference:data.reference,sha256:data.sha256,version:data.version,reportedCandleCoverage:m.candleCoverage,gaps:m.gaps,availability:m.availability,historicalUniverse:m.historicalUniverse,funding:m.funding.status,observedSourceFailures:m.sources.filter(s=>s.error!==null || s.body===null || s.status===null || s.status<200 || s.status>=300).length,status:'unvalidated' as const,executionAuthorized:false as const,unknowns:[frozenScope?'scope_registration_declaration_unverified':'scope_not_frozen_in_registration','historical_publication_unverified','historical_universe_unknown','history_manifest_not_independently_verified','candle_coverage_not_independently_verified','strategy_and_backtest_unvalidated']};
   db.exec('ROLLBACK');return output;
  } catch(e) {if(db.isTransaction)db.exec('ROLLBACK');throw e}
 } catch (error) {
  if (error instanceof DomainError && error.code==='PERSISTENCE_UNAVAILABLE') return fail('PERSISTENCE_UNAVAILABLE');
  if (error instanceof Error && 'code' in error && (error.code==='ERR_SQLITE_ERROR' || error.code==='ERR_INVALID_STATE')) return fail('PERSISTENCE_UNAVAILABLE');
  return fail();
 }
}

