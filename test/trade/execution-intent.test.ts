import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/store/db.ts';
import { compileDemoCard } from '../../src/trade/trade-card.ts';
import { createVetoWindowService } from '../../src/trade/veto-window.ts';
import { createExecutionIntentService } from '../../src/trade/execution-intent.ts';

const t0 = new Date('2026-11-02T08:00:05Z');
const cardInput = { scope: { scopeId: 'scope:synthetic', accountRef: 'account:synthetic', site: 'global', environment: 'demo' },
 strategy: { id: 'breakout-atr-trailing', version: 2, validation: 'unvalidated' },
 signal: { instId: 'BTC-USDT', product: 'spot', direction: 'long', signalCloseAt: '2026-11-02T08:00:00Z', atrUsdt: '2', initialStopAtr: '2', trailingStopAtr: '3', evidenceRefs: ['ev_synthetic'] },
 quote: { priceUsdt: '100', at: '2026-11-02T08:00:04Z', sourceRef: 'quote:synthetic', maxAgeSeconds: 30 },
 instrument: { instId: 'BTC-USDT', product: 'spot', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', listTime: null, tickSz: '0.1', lotSz: '0.0001', minSz: '0.001', ctVal: null },
 costModel: { feePpm: 1000, slippagePpm: 500, assumptionRef: 'costs:synthetic' },
 riskPolicy: { version: 1, spotBudgetUsdt: '30', perpetualBudgetUsdt: '0', maxSpotAssets: 2, maxPerpetualPositions: 0, maxSpotPlanLossUsdt: '5', maxPerpetualPlanLossUsdt: '0', maxPerpetualLeverage: '1' },
 maxPlanLossUsdt: '1', portfolio: { accountReconciled: true, lossLedgerBlocksNewRisk: false, commitments: [] }, validForSeconds: 3600 };
const grant = { version: 1, environment: 'demo', strategy: { id: 'breakout-atr-trailing', version: 2 }, instruments: [{ instId: 'BTC-USDT', product: 'spot' }],
 limits: { maxPlanLossUsdtPerCard: '1', maxCardsPerDay: 5, dailyLossLimitUsdt: '3', maxOpenPositions: 3 }, riskPolicyVersion: 1, vetoWindowSeconds: 600, validUntil: '2026-12-01T00:00:00Z' };
const active = { proposalId: 'grant:one', subjectHash: 'a'.repeat(64), scopeId: 'scope:synthetic', accountRef: 'account:synthetic', site: 'global', confirmedAt: '2026-11-01T00:00:00Z', grant };

function services(db: Db, clock: { now: Date }) {
 const veto = createVetoWindowService(db, { internalActive: () => active as never }, { current: () => ({ openPositions: 0, realizedLossTodayUsdt: '0' }) }, () => clock.now);
 return { veto, intents: createExecutionIntentService(db, () => clock.now) };
}
/** A card taken through submit, display and an unrejected window. */
function approvedCard(veto: ReturnType<typeof services>['veto'], clock: { now: Date }, over: Record<string, unknown> = {}) {
 const card = compileDemoCard({ ...cardInput, ...over }, () => t0).card!;
 clock.now = t0; veto.submit(card); veto.markDisplayed(card.contentSha256);
 clock.now = new Date(t0.getTime() + 600_000); veto.settle(card.contentSha256);
 return card;
}

test('an approved card is consumed into one intent with stable client order ids', () => {
 const db = openDb(':memory:'), clock = { now: t0 }; try {
  const { veto, intents } = services(db, clock);
  const card = approvedCard(veto, clock);
  const intent = intents.consume(card.contentSha256);
  assert.deepEqual([intent.state, intent.cardHash, intent.instId, intent.budgetUsdt, intent.plannedLossUsdt], ['reserved', card.contentSha256, 'BTC-USDT', card.risk.budgetRequiredUsdt, card.risk.plannedLossUsdt]);
  assert.deepEqual(intent.actions.map(a => a.role), ['entry', 'initial_stop', 'trailing_stop']);
  for (const a of intent.actions) assert.match(a.clientOrderId, /^[A-Za-z0-9]{1,32}$/);
  assert.equal(new Set(intent.actions.map(a => a.clientOrderId)).size, 3);
  assert.deepEqual(intents.consume(card.contentSha256), intent);
 } finally { db.close(); }
});

test('only an approved card can be consumed', () => {
 const db = openDb(':memory:'), clock = { now: t0 }; try {
  const { veto, intents } = services(db, clock);
  const waiting = compileDemoCard(cardInput, () => t0).card!; veto.submit(waiting);
  const rejected = compileDemoCard({ ...cardInput, maxPlanLossUsdt: '0.9' }, () => t0).card!; veto.submit(rejected); veto.reject(rejected.contentSha256);
  for (const hash of [waiting.contentSha256, rejected.contentSha256, '0'.repeat(64)])
   assert.throws(() => intents.consume(hash), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'intent.not_approved');
 } finally { db.close(); }
});

test('a second connection to the same database gets the same single intent', () => {
 const dir = mkdtempSync(join(tmpdir(), 'intent-')), path = join(dir, 'taoalpha.db'), clock = { now: t0 };
 const first = openDb(path), second = openDb(path);
 try {
  const { veto, intents } = services(first, clock);
  const card = approvedCard(veto, clock);
  const one = intents.consume(card.contentSha256);
  const other = createExecutionIntentService(second, () => clock.now).consume(card.contentSha256);
  assert.deepEqual(other, one);
  assert.equal((second.prepare('SELECT count(*) n FROM execution_intents').get() as { n: number }).n, 1);
 } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('every unreleased intent keeps its budget, plan loss and position slot in later risk checks', () => {
 const db = openDb(':memory:'), clock = { now: t0 }; try {
  const { veto, intents } = services(db, clock);
  const a = intents.consume(approvedCard(veto, clock).contentSha256);
  const b = intents.consume(approvedCard(veto, clock, { maxPlanLossUsdt: '0.5' }).contentSha256);
  const valuation = { at: '2026-11-02T09:00:00Z', pricesUsdt: { 'BTC-USDT': '110' } };
  const commitments = intents.openCommitments('scope:synthetic', valuation);
  assert.deepEqual(commitments.map(c => [c.sourceRef, c.stage, c.budgetUsdt, c.plannedLossUsdt, c.valuedAt]),
   [[a.intentId, 'pending', a.budgetUsdt, a.plannedLossUsdt, valuation.at], [b.intentId, 'pending', b.budgetUsdt, b.plannedLossUsdt, valuation.at]]);
  // 0.2328 BTC valued at 110.
  assert.equal(commitments[0]!.notionalUsdt, '25.608');
  assert.equal(intents.openPositions('scope:synthetic'), 2);
  assert.throws(() => intents.openCommitments('scope:synthetic', { at: valuation.at, pricesUsdt: {} }), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'intent.valuation_missing');
  assert.deepEqual([intents.openCommitments('scope:other', valuation), intents.openPositions('scope:other')], [[], 0]);
 } finally { db.close(); }
});

test('an intent whose card expired without any order ever sent is released; one that was sent stays open', () => {
 const db = openDb(':memory:'), clock = { now: t0 }; try {
  const { veto, intents } = services(db, clock);
  const unsent = intents.consume(approvedCard(veto, clock).contentSha256);
  const sent = intents.consume(approvedCard(veto, clock, { maxPlanLossUsdt: '0.5' }).contentSha256);
  db.exec("CREATE TABLE IF NOT EXISTS execution_submissions(client_order_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL,role TEXT NOT NULL,args_json TEXT NOT NULL,sent_at TEXT NOT NULL)");
  db.prepare('INSERT INTO execution_submissions VALUES(?,?,?,?,?)').run(sent.actions[0]!.clientOrderId, sent.intentId, 'entry', '{}', t0.toISOString());
  assert.equal(intents.openPositions('scope:synthetic'), 2);
  // Both cards expire an hour after compilation.
  clock.now = new Date(t0.getTime() + 3_600_000);
  assert.deepEqual(intents.list('scope:synthetic').map(i => i.intentId), [sent.intentId]);
  assert.equal(intents.openPositions('scope:synthetic'), 1);
  assert.equal(unsent.state, 'reserved');
 } finally { db.close(); }
});
