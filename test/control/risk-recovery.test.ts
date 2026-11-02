import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { createConfirmationService } from '../../src/control/confirmations.ts';
import { createRiskRecoveryService } from '../../src/control/risk-recovery.ts';
import { createDemoExecutor } from '../../src/trade/demo-executor.ts';

const now = () => new Date('2026-11-03T08:00:00Z');
const scope = { scopeId: 'scope:demo-main', accountRef: 'account:demo', site: 'global' as const, environment: 'demo' as const };
const writer = { placeEntry: async () => ({ status: 'unknown' as const }), placeAlgo: async () => ({ status: 'unknown' as const }), cancelOrder: async () => ({ status: 'unknown' as const }), cancelAlgo: async () => ({ status: 'unknown' as const }) };

function setup(verify: 'verified' | 'denied' = 'verified') {
 const db = openDb(':memory:');
 const confirmations = createConfirmationService(db, { reviewAndVerify: async () => ({ status: verify }) }, now);
 const executor = createDemoExecutor(db, writer, now);
 // Minimal exited-intent fact, as recorded by the execution intent service.
 db.exec(`CREATE TABLE IF NOT EXISTS execution_exits(intent_id TEXT PRIMARY KEY, detected_at TEXT NOT NULL); INSERT INTO execution_exits VALUES('intent_exited','2026-11-02T10:00:00Z');`);
 return { db, executor, confirmations, recovery: createRiskRecoveryService(db, confirmations, now) };
}

test('one lock is lifted only by a verified, single-use recovery confirmation, after its intent exited', async () => {
 const { db, executor, confirmations, recovery } = setup(); try {
  executor.lockNewRisk('intent_exited', 'protection_missing');
  executor.lockNewRisk('intent_other', 'protection_missing');
  const proposal = recovery.propose(scope, { intentId: 'intent_exited', reason: 'protection_missing' });
  const decision = await confirmations.reviewAndConfirm(proposal.requestId);
  assert.equal(recovery.confirm(proposal.proposalId, decision.receiptId!).status, 'unlocked');
  // Only that lock: the other one still blocks.
  assert.deepEqual(executor.riskLocks().map(l => l.intentId), ['intent_other']);
  assert.throws(() => recovery.confirm(proposal.proposalId, decision.receiptId!));
  assert.throws(() => db.prepare('DELETE FROM execution_risk_unlocks').run());
 } finally { db.close(); }
});

test('an open intent, a denied verification or an unknown lock cannot be unlocked', async () => {
 const denied = setup('denied'); try {
  denied.executor.lockNewRisk('intent_exited', 'protection_missing');
  const p = denied.recovery.propose(scope, { intentId: 'intent_exited', reason: 'protection_missing' });
  assert.equal((await denied.confirmations.reviewAndConfirm(p.requestId)).status, 'denied');
  assert.equal(denied.executor.riskLocks().length, 1);
 } finally { denied.db.close(); }
 const { db, executor, recovery } = setup(); try {
  executor.lockNewRisk('intent_open', 'protection_missing');
  assert.throws(() => recovery.propose(scope, { intentId: 'intent_open', reason: 'protection_missing' }), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'recovery.intent_not_exited');
  assert.throws(() => recovery.propose(scope, { intentId: 'intent_exited', reason: 'not_a_lock' }), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'recovery.lock_unknown');
 } finally { db.close(); }
});
