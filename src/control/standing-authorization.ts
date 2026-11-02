import { z } from 'zod';
import { dec, isDecimalString } from '../lib/decimal.ts';
import { canonicalJson, hashJson } from '../lib/hash.ts';
import { DomainError } from '../lib/errors.ts';
import { getRow, inTransaction, type Db } from '../store/db.ts';
import { verifiedDemoSnapshot, type DemoSnapshot } from '../account/demo-snapshot.ts';
import { parseConfirmationProposal, type ConfirmationSubject } from './confirmation-schema.ts';
import type { createConfirmationService } from './confirmations.ts';

const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const positiveInt = (max:number) => z.number().int().min(1).max(max);
const positiveMoney = z.string().max(40).refine(v => isDecimalString(v) && dec(v).gt(0));
const instrument = z.strictObject({ instId: z.string().regex(/^[A-Z0-9]+-USDT(?:-SWAP)?$/), product: z.enum(['spot', 'usdt_perpetual']) })
 .refine(i => (i.product === 'spot') !== i.instId.endsWith('-SWAP'));
/** What the user confirms once (ADR-012); every card inside it then only needs an unrejected veto window. */
export const grantSchema = z.strictObject({
 version: positiveInt(Number.MAX_SAFE_INTEGER), environment: z.enum(['demo', 'live']),
 strategy: z.strictObject({ id: ref, version: positiveInt(Number.MAX_SAFE_INTEGER) }),
 instruments: z.array(instrument).min(1).max(20).refine(list => new Set(list.map(i => i.instId)).size === list.length),
 limits: z.strictObject({ maxPlanLossUsdtPerCard: positiveMoney, maxCardsPerDay: positiveInt(100), dailyLossLimitUsdt: positiveMoney, maxOpenPositions: positiveInt(50) }),
 riskPolicyVersion: positiveInt(Number.MAX_SAFE_INTEGER), vetoWindowSeconds: z.number().int().min(60).max(86400), validUntil: z.iso.datetime({ offset: true }),
});
export type StandingGrant = z.infer<typeof grantSchema>;
const inputSchema = z.strictObject({ proposalId: ref, grant: grantSchema, confirmBy: z.iso.datetime({ offset: true }) });
type Row = { id: string; request_id: string; subject_json: string; subject_hash: string; scope_id: string; account_ref: string; site: string; version: number };

function fail(ruleId = 'standing_authorization.rejected'): never { throw new DomainError('INVALID_INPUT', 'Standing authorization operation rejected', [{ ruleId }]); }
// Domain rejections keep their rule; anything else (storage, parsing) becomes a generic rejection.
function safe<T>(f: () => T): T {
 try { return f(); }
 catch (e) { if (e instanceof DomainError && e.violations.some(v => v.ruleId.startsWith('standing_authorization.'))) throw e; return fail(); }
}
const TABLES = ['standing_authorization_proposals', 'standing_authorization_confirmations', 'standing_authorization_revocations'];
const DDL = [
 `CREATE TABLE IF NOT EXISTS standing_authorization_proposals(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,subject_json TEXT NOT NULL,subject_hash TEXT NOT NULL,scope_id TEXT NOT NULL,account_ref TEXT NOT NULL,site TEXT NOT NULL,version INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS standing_authorization_confirmations(proposal_id TEXT PRIMARY KEY REFERENCES standing_authorization_proposals(id),scope_id TEXT NOT NULL,version INTEGER NOT NULL,receipt_id TEXT UNIQUE NOT NULL,confirmed_at TEXT NOT NULL,UNIQUE(scope_id,version))`,
 `CREATE TABLE IF NOT EXISTS standing_authorization_revocations(proposal_id TEXT PRIMARY KEY REFERENCES standing_authorization_proposals(id),revoked_at TEXT NOT NULL)`,
 ...TABLES.flatMap(t => [`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`, `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`]),
];

/** Backend-only: dependencies are constructed by the trusted process, never from a request. Grants no execution by itself. */
export function createStandingAuthorizationService(db: Db, session: { getInternalSnapshot(): DemoSnapshot | null }, confirmations: ReturnType<typeof createConfirmationService>, now: () => Date) {
 safe(() => inTransaction(db, () => { for (const sql of DDL) db.exec(sql); }));
 function clock() { const n = now(); if (!(n instanceof Date) || !Number.isFinite(n.getTime()) || n.getTime() <= 0) fail(); return n.getTime(); }
 const snapshot = () => verifiedDemoSnapshot(db, session.getInternalSnapshot(), clock());
 const hasTable = (name: string) => !!getRow(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
 const revoked = (id: string) => !!getRow(db, 'SELECT 1 FROM standing_authorization_revocations WHERE proposal_id=?', id);
 // The grant must point at a registered strategy version and a risk policy confirmed for the same account scope.
 function checkReferences(grant: StandingGrant, scopeId: string) {
  if (!hasTable('experiment_strategy_versions') || !getRow(db, 'SELECT 1 FROM experiment_strategy_versions WHERE strategy_id=? AND version=?', grant.strategy.id, grant.strategy.version)) fail('standing_authorization.strategy_unregistered');
  if (!hasTable('demo_risk_policy_confirmations') || !getRow(db, 'SELECT 1 FROM demo_risk_policy_confirmations WHERE scope_id=? AND version=?', scopeId, grant.riskPolicyVersion)) fail('standing_authorization.risk_policy_unconfirmed');
 }
 function load(id: string) { const row = getRow<Row>(db, 'SELECT * FROM standing_authorization_proposals WHERE id=?', id); if (!row) fail('standing_authorization.unknown'); return row; }
 function subject(row: Row) {
  const s = parseConfirmationProposal({ requestRef: 'integrity', subject: JSON.parse(row.subject_json) }).subject;
  const g = grantSchema.safeParse(s.payload.grant);
  if (!g.success || Object.keys(s.payload).join(',') !== 'grant' || s.kind !== 'standing_authorization' || s.scopeId !== row.scope_id || s.accountRef !== row.account_ref || s.site !== row.site
   || s.version !== row.version || g.data.version !== row.version || canonicalJson(s) !== row.subject_json || hashJson(s) !== row.subject_hash) fail();
  const request = getRow<{ subject_json: string; subject_hash: string }>(db, 'SELECT subject_json,subject_hash FROM confirmation_requests WHERE id=?', row.request_id);
  if (!request || request.subject_json !== row.subject_json || request.subject_hash !== row.subject_hash) fail();
  return { subject: s, grant: g.data };
 }
 function status(row: Row, grant: StandingGrant) {
  if (revoked(row.id)) return 'revoked' as const;
  if (!getRow(db, 'SELECT 1 FROM standing_authorization_confirmations WHERE proposal_id=?', row.id)) return 'pending' as const;
  if (clock() >= Date.parse(grant.validUntil)) return 'expired' as const;
  return getRow(db, 'SELECT 1 FROM standing_authorization_confirmations WHERE scope_id=? AND version>?', row.scope_id, row.version) ? 'superseded' as const : 'active' as const;
 }
 // Summaries never echo limits or amounts; only the backend reads the grant itself.
 function summary(row: Row) { const { grant } = subject(row); return { proposalId: row.id, requestId: row.request_id, subjectHash: row.subject_hash, version: row.version, status: status(row, grant), executionAuthorized: false as const }; }
 return {
  propose(raw: unknown) { return safe(() => {
   const checked = parseConfirmationProposal({ requestRef: 'input', subject: { kind: 'standing_authorization', version: 1, scopeId: 'scope:input', accountRef: 'account:input', site: 'global', environment: 'demo', expiresAt: '2099-01-01T00:00:00Z', payload: { input: raw } } }).subject.payload.input;
   const parsed = inputSchema.safeParse(checked); if (!parsed.success || canonicalJson(checked) !== canonicalJson(parsed.data)) fail();
   const { proposalId, grant, confirmBy } = parsed.data;
   // ADR-012 / I-02: no live grant until a validated strategy, the demo loop and a live activation record exist.
   if (grant.environment === 'live') fail('standing_authorization.live_requires_activation');
   if (Date.parse(confirmBy) <= clock() || Date.parse(grant.validUntil) <= Date.parse(confirmBy)) fail('standing_authorization.expiry');
   const snap = snapshot(); checkReferences(grant, snap.scopeId);
   const s: ConfirmationSubject = { kind: 'standing_authorization', scopeId: snap.scopeId, accountRef: snap.accountRef, site: snap.site, environment: grant.environment, version: grant.version, expiresAt: confirmBy, payload: { grant } };
   const proposal = confirmations.propose({ requestRef: proposalId, subject: s });
   return inTransaction(db, () => {
    const prior = getRow<Row>(db, 'SELECT * FROM standing_authorization_proposals WHERE id=?', proposalId);
    if (prior) { if (prior.request_id !== proposal.requestId || prior.subject_json !== canonicalJson(s)) fail(); return summary(prior); }
    db.prepare('INSERT INTO standing_authorization_proposals VALUES(?,?,?,?,?,?,?,?)').run(proposalId, proposal.requestId, canonicalJson(s), proposal.subjectHash, s.scopeId, s.accountRef, s.site, grant.version);
    return summary(load(proposalId));
   });
  }); },
  confirm(proposalId: string, receiptId: string) { return safe(() => {
   const snap = snapshot();
   return inTransaction(db, () => {
    const row = load(proposalId); const { subject: s, grant } = subject(row);
    if (s.scopeId !== snap.scopeId || s.accountRef !== snap.accountRef || s.site !== snap.site) fail();
    if (revoked(proposalId)) fail('standing_authorization.revoked');
    const receipt = confirmations.getReceipt(receiptId); if (receipt.requestId !== row.request_id || receipt.subjectHash !== row.subject_hash) fail();
    const prior = getRow<{ receipt_id: string }>(db, 'SELECT receipt_id FROM standing_authorization_confirmations WHERE proposal_id=?', proposalId);
    if (prior) { if (prior.receipt_id !== receiptId) fail(); return summary(row); }
    const latest = getRow<{ version: number }>(db, 'SELECT version FROM standing_authorization_confirmations WHERE scope_id=? ORDER BY version DESC LIMIT 1', row.scope_id);
    if (latest && row.version <= latest.version) fail('standing_authorization.version');
    checkReferences(grant, row.scope_id);
    confirmations.consume(receiptId, s);
    db.prepare('INSERT INTO standing_authorization_confirmations VALUES(?,?,?,?,?)').run(proposalId, row.scope_id, row.version, receiptId, new Date(clock()).toISOString());
    return summary(row);
   });
  }); },
  /** Revoking only lowers risk, so it needs no system verification; it is immediate and permanent. */
  revoke(proposalId: string) { return safe(() => inTransaction(db, () => {
   const row = load(proposalId); subject(row);
   if (!revoked(proposalId)) db.prepare('INSERT INTO standing_authorization_revocations VALUES(?,?)').run(proposalId, new Date(clock()).toISOString());
   return summary(row);
  })); },
  get(proposalId: string) { return safe(() => summary(load(proposalId))); },
  /** The active grant for the current demo account scope, or null. Backend-internal: includes the limits. */
  internalActive() { return safe(() => {
   const snap = snapshot();
   const latest = getRow<{ proposal_id: string; confirmed_at: string }>(db, 'SELECT proposal_id,confirmed_at FROM standing_authorization_confirmations WHERE scope_id=? ORDER BY version DESC LIMIT 1', snap.scopeId);
   if (!latest) return null;
   const row = load(latest.proposal_id); const { grant } = subject(row);
   if (status(row, grant) !== 'active' || row.account_ref !== snap.accountRef || row.site !== snap.site) return null;
   return { proposalId: row.id, subjectHash: row.subject_hash, scopeId: row.scope_id, accountRef: row.account_ref, site: row.site, confirmedAt: latest.confirmed_at, grant };
  }); },
 };
}
