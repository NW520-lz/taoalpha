import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { createConfirmationService } from '../../src/control/confirmations.ts';
import { createStandingAuthorizationService } from '../../src/control/standing-authorization.ts';

const at = new Date('2026-11-02T12:00:00Z');
// Synthetic limits only; real values come from the user's confirmed grant.
const grant = { version: 1, environment: 'demo', strategy: { id: 'breakout-atr-trailing', version: 2 }, instruments: [{ instId: 'BTC-USDT', product: 'spot' }],
 limits: { maxPlanLossUsdtPerCard: '1', maxCardsPerDay: 2, dailyLossLimitUsdt: '3', maxOpenPositions: 1 }, riskPolicyVersion: 1, vetoWindowSeconds: 600, validUntil: '2026-12-01T00:00:00Z' };

function setup(verify: 'verified' | 'denied' = 'verified') {
 const db = openDb(':memory:');
 db.exec(`CREATE TABLE demo_account_scopes(scope_id TEXT PRIMARY KEY,account_ref TEXT,site TEXT,environment TEXT); INSERT INTO demo_account_scopes VALUES('scope:synthetic','account:synthetic','global','demo');
  CREATE TABLE demo_account_identity_conflicts(scope_id TEXT PRIMARY KEY); CREATE TABLE demo_account_refresh_events(seq INTEGER PRIMARY KEY,scope_id TEXT,status TEXT); INSERT INTO demo_account_refresh_events VALUES(1,'scope:synthetic','ok');
  CREATE TABLE demo_risk_policy_confirmations(proposal_id TEXT PRIMARY KEY,scope_id TEXT,version INTEGER,receipt_id TEXT); INSERT INTO demo_risk_policy_confirmations VALUES('proposal:policy','scope:synthetic',1,'receipt:policy');
  CREATE TABLE experiment_strategy_versions(strategy_id TEXT,version INTEGER,content TEXT); INSERT INTO experiment_strategy_versions VALUES('breakout-atr-trailing',2,'{}');`);
 let now = at;
 const snapshot = { scopeId: 'scope:synthetic', accountRef: 'account:synthetic', site: 'global', environment: 'demo', generation: 1, validUntilMs: at.getTime() + 60 * 86_400_000, reconciled: false, executionAuthorized: false, blockNewRisk: true };
 const confirmations = createConfirmationService(db, { reviewAndVerify: async () => ({ status: verify }) }, () => now);
 const service = createStandingAuthorizationService(db, { getInternalSnapshot: () => snapshot } as never, confirmations, () => now);
 return { db, service, confirmations, setNow: (d: Date) => { now = d; } };
}
const propose = (service: ReturnType<typeof setup>['service'], id = 'grant:one', g: unknown = grant) => service.propose({ proposalId: id, grant: g, confirmBy: '2026-11-02T12:10:00Z' });

test('a grant confirmed through the trusted entry becomes the active standing authorization', async () => {
 const { db, service, confirmations } = setup(); try {
  const pending = propose(service);
  assert.deepEqual([pending.status, service.internalActive()], ['pending', null]);
  const receipt = (await confirmations.reviewAndConfirm(pending.requestId)).receiptId!;
  const confirmed = service.confirm('grant:one', receipt);
  assert.deepEqual([confirmed.status, confirmed.executionAuthorized], ['active', false]);
  const active = service.internalActive()!;
  assert.deepEqual([active.proposalId, active.subjectHash, active.grant], ['grant:one', pending.subjectHash, grant]);
 } finally { db.close(); }
});

test('denied verification, live grants, unknown references and bad limits never become active', async () => {
 const { db, service, confirmations } = setup('denied'); try {
  const pending = propose(service);
  assert.equal((await confirmations.reviewAndConfirm(pending.requestId)).status, 'denied');
  assert.equal(service.internalActive(), null);
  const rule = (f: () => unknown, id: string) => assert.throws(f, (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === id);
  rule(() => propose(service, 'grant:live', { ...grant, environment: 'live' }), 'standing_authorization.live_requires_activation');
  rule(() => propose(service, 'grant:strategy', { ...grant, strategy: { id: 'unknown', version: 1 } }), 'standing_authorization.strategy_unregistered');
  rule(() => propose(service, 'grant:policy', { ...grant, riskPolicyVersion: 2 }), 'standing_authorization.risk_policy_unconfirmed');
  rule(() => propose(service, 'grant:expiry', { ...grant, validUntil: '2026-11-02T12:05:00Z' }), 'standing_authorization.expiry');
  assert.throws(() => propose(service, 'grant:zero', { ...grant, limits: { ...grant.limits, maxPlanLossUsdtPerCard: '0' } }));
  assert.throws(() => propose(service, 'grant:window', { ...grant, vetoWindowSeconds: 10 }));
  assert.doesNotMatch(JSON.stringify(pending), /maxPlanLoss|dailyLoss|"3"/);
 } finally { db.close(); }
});

test('revocation is immediate and permanent, and needs no verification', async () => {
 const { db, service, confirmations } = setup(); try {
  const active = propose(service);
  service.confirm('grant:one', (await confirmations.reviewAndConfirm(active.requestId)).receiptId!);
  assert.equal(service.revoke('grant:one').status, 'revoked');
  assert.equal(service.internalActive(), null);
  assert.equal(service.revoke('grant:one').status, 'revoked');
  // A pending grant revoked before confirmation can never be confirmed.
  const later = propose(service, 'grant:two', { ...grant, version: 2 });
  const receipt = (await confirmations.reviewAndConfirm(later.requestId)).receiptId!;
  service.revoke('grant:two');
  assert.throws(() => service.confirm('grant:two', receipt), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'standing_authorization.revoked');
  assert.throws(() => db.prepare('DELETE FROM standing_authorization_revocations').run());
 } finally { db.close(); }
});

test('a grant expires at validUntil, a newer version supersedes it, and older versions cannot follow', async () => {
 const { db, service, confirmations, setNow } = setup(); try {
  const confirm = async (id: string, version: number) => { const p = propose(service, id, { ...grant, version }); return service.confirm(id, (await confirmations.reviewAndConfirm(p.requestId)).receiptId!); };
  await confirm('grant:v2', 2);
  const stale = propose(service, 'grant:v1', { ...grant, version: 1 });
  const staleReceipt = (await confirmations.reviewAndConfirm(stale.requestId)).receiptId!;
  assert.throws(() => service.confirm('grant:v1', staleReceipt), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'standing_authorization.version');
  await confirm('grant:v3', 3);
  assert.deepEqual([service.get('grant:v2').status, service.internalActive()?.proposalId], ['superseded', 'grant:v3']);
  setNow(new Date('2026-12-01T00:00:00Z'));
  assert.deepEqual([service.get('grant:v3').status, service.internalActive()], ['expired', null]);
 } finally { db.close(); }
});

test('a receipt for another request cannot confirm a grant', async () => {
 const { db, service, confirmations } = setup(); try {
  const one = propose(service); const two = propose(service, 'grant:two', { ...grant, version: 2 });
  const receiptForTwo = (await confirmations.reviewAndConfirm(two.requestId)).receiptId!;
  assert.throws(() => service.confirm('grant:one', receiptForTwo));
  assert.equal(service.get(one.proposalId).status, 'pending');
 } finally { db.close(); }
});
