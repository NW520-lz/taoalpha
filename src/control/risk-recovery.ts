import { canonicalJson } from '../lib/hash.ts';
import { DomainError } from '../lib/errors.ts';
import { getRow, inTransaction, type Db } from '../store/db.ts';
import { parseConfirmationProposal, type ConfirmationSubject } from './confirmation-schema.ts';
import type { createConfirmationService } from './confirmations.ts';

type Scope = { scopeId: string; accountRef: string; site: 'global' | 'eea' | 'us' | 'tr'; environment: 'demo' | 'live' };
function fail(ruleId: string): never { throw new DomainError('INVALID_INPUT', 'Risk recovery rejected', [{ ruleId }]); }
const DDL = [
 `CREATE TABLE IF NOT EXISTS risk_recovery_proposals(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,subject_json TEXT NOT NULL,intent_id TEXT NOT NULL,reason TEXT NOT NULL)`,
 `CREATE TRIGGER IF NOT EXISTS risk_recovery_proposals_no_update BEFORE UPDATE ON risk_recovery_proposals BEGIN SELECT RAISE(ABORT,'immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS risk_recovery_proposals_no_delete BEFORE DELETE ON risk_recovery_proposals BEGIN SELECT RAISE(ABORT,'immutable'); END`,
];

/**
 * I-15 recovery of one execution risk lock. The user confirms the specific lock through the trusted entry; the
 * receipt is consumed in the same transaction that records the unlock, and only that lock is lifted. A lock can be
 * recovered only after its intent exited and was released, so recovery never re-opens unprotected exposure.
 */
export function createRiskRecoveryService(db: Db, confirmations: ReturnType<typeof createConfirmationService>, now: () => Date) {
 inTransaction(db, () => { for (const sql of DDL) db.exec(sql); });
 const lockOf = (intentId: string, reason: string) => getRow<{ locked_at: string }>(db,
  'SELECT locked_at FROM execution_risk_locks l WHERE intent_id=? AND reason=? AND NOT EXISTS (SELECT 1 FROM execution_risk_unlocks u WHERE u.intent_id=l.intent_id AND u.reason=l.reason)', intentId, reason);
 const hasTable = (name: string) => !!getRow(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
 return {
  propose(scope: Scope, lock: { intentId: string; reason: string }) {
   const locked = hasTable('execution_risk_locks') ? lockOf(lock.intentId, lock.reason) : undefined;
   if (!locked) fail('recovery.lock_unknown');
   if (!hasTable('execution_exits') || !getRow(db, 'SELECT 1 FROM execution_exits WHERE intent_id=?', lock.intentId)) fail('recovery.intent_not_exited');
   const subject: ConfirmationSubject = { kind: 'risk_recovery', version: 1, ...scope, expiresAt: new Date(now().getTime() + 600_000).toISOString(),
    payload: { intentId: lock.intentId, reason: lock.reason, lockedAt: locked.locked_at, condition: 'the locked intent has exited and been released; this lifts only this lock' } };
   const id = `recovery:${lock.intentId}:${lock.reason}:${locked.locked_at}`;
   const proposal = confirmations.propose({ requestRef: id, subject });
   inTransaction(db, () => { if (!getRow(db, 'SELECT 1 FROM risk_recovery_proposals WHERE id=?', id)) db.prepare('INSERT INTO risk_recovery_proposals VALUES(?,?,?,?,?)').run(id, proposal.requestId, canonicalJson(subject), lock.intentId, lock.reason); });
   return { proposalId: id, requestId: proposal.requestId };
  },
  confirm(proposalId: string, receiptId: string) {
   return inTransaction(db, () => {
    const row = getRow<{ subject_json: string; intent_id: string; reason: string }>(db, 'SELECT subject_json,intent_id,reason FROM risk_recovery_proposals WHERE id=?', proposalId);
    if (!row) fail('recovery.unknown');
    if (!lockOf(row.intent_id, row.reason)) fail('recovery.already_unlocked');
    const subject = parseConfirmationProposal({ requestRef: 'stored', subject: JSON.parse(row.subject_json) }).subject;
    confirmations.consume(receiptId, subject);
    db.prepare('INSERT INTO execution_risk_unlocks VALUES(?,?,?,?)').run(row.intent_id, row.reason, receiptId, now().toISOString());
    return { status: 'unlocked' as const, intentId: row.intent_id, reason: row.reason };
   });
  },
 };
}
