import { z } from 'zod';
import { Decimal, dec, isDecimalString } from '../lib/decimal.ts';
import { canonicalJson, hashJson } from '../lib/hash.ts';
import { DomainError } from '../lib/errors.ts';
import { getRow, inTransaction, type Db } from '../store/db.ts';
import { parseConfirmationProposal, type ConfirmationSubject } from '../control/confirmation-schema.ts';
import type { createConfirmationService } from '../control/confirmations.ts';
import type { createDemoAccountSession } from '../account/demo-session.ts';

const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
// At most 40 characters per operand: 40 integer digits plus 38 fractional digits and a carry fit within 100 significant digits.
const BudgetDecimal = Decimal.clone({ precision: 100 });
const money = z.string().max(40).refine(v => isDecimalString(v) && dec(v).gte(0));
const positive = money.refine(v => dec(v).gt(0));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const policySchema = z.strictObject({id:ref,version:count.refine(v=>v>0),initialEquityUsdt:positive,
 budgetsUsdt:z.strictObject({reserve:money,spot:money,perpetual:money}),
 lossLinesUsdt:z.strictObject({review:positive,pause:positive,stop:positive}),
 limits:z.strictObject({maxSpotAssets:count,maxPerpetualPositions:count,maxSpotPlanLossUsdt:money,maxPerpetualPlanLossUsdt:money,maxPerpetualLeverage:positive.refine(v=>dec(v).gte(1))})
}).refine(p=>new BudgetDecimal(p.budgetsUsdt.reserve).plus(p.budgetsUsdt.spot).plus(p.budgetsUsdt.perpetual).lte(new BudgetDecimal(p.initialEquityUsdt)) && dec(p.lossLinesUsdt.review).lt(dec(p.lossLinesUsdt.pause)) && dec(p.lossLinesUsdt.pause).lt(dec(p.lossLinesUsdt.stop)));
const inputSchema = z.strictObject({proposalId:ref,policy:policySchema,expiresAt:z.iso.datetime({offset:true})});
type Row = { id:string; request_id:string; subject_json:string; subject_hash:string; scope_id:string; account_ref:string; site:string; policy_id:string; version:number };
type Snapshot = NonNullable<ReturnType<ReturnType<typeof createDemoAccountSession>['getInternalSnapshot']>>;
function fail(): never { throw new DomainError('INVALID_INPUT','Demo risk policy operation rejected',[{ruleId:'demo_policy.rejected'}]); }
function safe<T>(f:()=>T):T { try{return f()}catch{ return fail() } }
const tables = [
 `CREATE TABLE IF NOT EXISTS demo_risk_policy_proposals(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,subject_json TEXT NOT NULL,subject_hash TEXT NOT NULL,scope_id TEXT NOT NULL,account_ref TEXT NOT NULL,site TEXT NOT NULL,policy_id TEXT NOT NULL,version INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS demo_risk_policy_confirmations(proposal_id TEXT PRIMARY KEY REFERENCES demo_risk_policy_proposals(id),scope_id TEXT NOT NULL,version INTEGER NOT NULL,receipt_id TEXT UNIQUE NOT NULL,UNIQUE(scope_id,version))`,
 ...['demo_risk_policy_proposals','demo_risk_policy_confirmations'].flatMap(t=>[`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`,`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`])
];
/** Backend-only: dependencies must be constructed by the trusted process, never from a request. */
export function createDemoRiskPolicyService(db:Db, session:Pick<ReturnType<typeof createDemoAccountSession>,'getInternalSnapshot'>, confirmations:ReturnType<typeof createConfirmationService>, now:()=>Date) {
 safe(()=>inTransaction(db,()=>{for(const sql of tables) db.exec(sql)}));
 function clock() { const n=now(); if (!(n instanceof Date) || !Number.isFinite(n.getTime()) || n.getTime()<=0) fail(); return n.getTime(); }
 function check(s:Snapshot|null) {
  if (!s || s.environment!=='demo' || s.reconciled!==false || s.executionAuthorized!==false || s.blockNewRisk!==true || !Number.isSafeInteger(s.generation) || !Number.isFinite(s.validUntilMs) || clock()>s.validUntilMs) fail();
  const binding=getRow<{account_ref:string;site:string;environment:string}>(db,'SELECT account_ref,site,environment FROM demo_account_scopes WHERE scope_id=?',s.scopeId);
  const event=getRow<{seq:number;status:string}>(db,'SELECT seq,status FROM demo_account_refresh_events WHERE scope_id=? ORDER BY seq DESC LIMIT 1',s.scopeId);
  if (!binding || binding.account_ref!==s.accountRef || binding.site!==s.site || binding.environment!=='demo' || event?.seq!==s.generation || event.status!=='ok' || getRow(db,'SELECT scope_id FROM demo_account_identity_conflicts WHERE scope_id=?',s.scopeId)) fail();
  return s;
 }
 function load(id:string) { const row=getRow<Row>(db,'SELECT * FROM demo_risk_policy_proposals WHERE id=?',id); if(!row) fail(); return row; }
 function subject(row:Row) {
  const s=parseConfirmationProposal({requestRef:'integrity',subject:JSON.parse(row.subject_json)}).subject;
  const p=policySchema.safeParse(s.payload.policy);
  if (!p.success || Object.keys(s.payload).sort().join(',')!=='baselineStatus,policy' || s.payload.baselineStatus!=='unreconciled' || s.kind!=='risk_policy' || s.environment!=='demo' || s.scopeId!==row.scope_id || s.accountRef!==row.account_ref || s.site!==row.site || s.version!==row.version || p.data.version!==row.version || p.data.id!==row.policy_id || canonicalJson(s)!==row.subject_json || hashJson(s)!==row.subject_hash) fail();
  const request=getRow<{subject_json:string;subject_hash:string}>(db,'SELECT subject_json,subject_hash FROM confirmation_requests WHERE id=?',row.request_id);
  if (!request || request.subject_json!==row.subject_json || request.subject_hash!==row.subject_hash) fail();
  return s;
 }
 function summary(row:Row) { subject(row); const confirmed=getRow(db,'SELECT proposal_id FROM demo_risk_policy_confirmations WHERE proposal_id=?',row.id); return {proposalId:row.id,requestId:row.request_id,subjectHash:row.subject_hash,scopeId:row.scope_id,accountRef:row.account_ref,policyId:row.policy_id,version:row.version,status:confirmed?'confirmed' as const:'pending' as const,reconciled:false as const,executionAuthorized:false as const,blockNewRisk:true as const}; }
 return {
  propose(raw:unknown) { return safe(()=>{
   // Existing confirmation parser rejects getters, exotic prototypes and lossy JSON before schema parsing.
   const checked=parseConfirmationProposal({requestRef:'input',subject:{kind:'risk_policy',version:1,scopeId:'scope:input',accountRef:'account:input',site:'global',environment:'demo',expiresAt:'2099-01-01T00:00:00Z',payload:{input:raw}}}).subject.payload.input;
   const parsed=inputSchema.safeParse(checked); if(!parsed.success || canonicalJson(checked)!==canonicalJson(parsed.data)) fail();
   const input=parsed.data; const snap=check(session.getInternalSnapshot());
   const s:ConfirmationSubject={kind:'risk_policy',scopeId:snap.scopeId,accountRef:snap.accountRef,site:snap.site,environment:'demo',version:input.policy.version,expiresAt:input.expiresAt,payload:{policy:input.policy,baselineStatus:'unreconciled'}};
   const proposal=confirmations.propose({requestRef:input.proposalId,subject:s});
   return inTransaction(db,()=>{ check(snap); const prior=getRow<Row>(db,'SELECT * FROM demo_risk_policy_proposals WHERE id=?',input.proposalId);
    if(prior) { if(prior.request_id!==proposal.requestId || prior.subject_json!==canonicalJson(s) || prior.subject_hash!==proposal.subjectHash) fail(); return summary(prior); }
    db.prepare('INSERT INTO demo_risk_policy_proposals VALUES(?,?,?,?,?,?,?,?,?)').run(input.proposalId,proposal.requestId,canonicalJson(s),proposal.subjectHash,s.scopeId,s.accountRef,s.site,input.policy.id,input.policy.version);
    return summary(load(input.proposalId)); });
  })},
  confirm(proposalId:string,receiptId:string) { return safe(()=>{
   if(arguments.length!==2 || !ref.safeParse(proposalId).success || !ref.safeParse(receiptId).success) fail();
   const snap=check(session.getInternalSnapshot());
   return inTransaction(db,()=>{check(snap); const row=load(proposalId); const s=subject(row);
    if(s.scopeId!==snap.scopeId || s.accountRef!==snap.accountRef || s.site!==snap.site || clock()>=Date.parse(s.expiresAt)) fail();
    const receipt=confirmations.getReceipt(receiptId); if(receipt.requestId!==row.request_id || receipt.subjectHash!==row.subject_hash) fail();
    const prior=getRow<{receipt_id:string}>(db,'SELECT receipt_id FROM demo_risk_policy_confirmations WHERE proposal_id=?',proposalId);
    if(prior) {if(prior.receipt_id!==receiptId) fail(); return summary(row)}
    const latest=getRow<{version:number}>(db,'SELECT version FROM demo_risk_policy_confirmations WHERE scope_id=? ORDER BY version DESC LIMIT 1',row.scope_id);
    if(latest && row.version<=latest.version) fail();
    confirmations.consume(receiptId,s);
    db.prepare('INSERT INTO demo_risk_policy_confirmations VALUES(?,?,?,?)').run(proposalId,row.scope_id,row.version,receiptId);
    return summary(row);
   });
  })},
  get(proposalId:string) {return safe(()=>{if(arguments.length!==1 || !ref.safeParse(proposalId).success) fail(); return summary(load(proposalId))})}
 };
}

