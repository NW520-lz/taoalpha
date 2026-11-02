import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { compileDemoCard } from '../../src/trade/trade-card.ts';
import { createVetoWindowService } from '../../src/trade/veto-window.ts';
import { createExecutionIntentService } from '../../src/trade/execution-intent.ts';
import { createDemoExecutor, type DemoWriter, type WriteOutcome } from '../../src/trade/demo-executor.ts';

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
const at = (s: number) => new Date(t0.getTime() + s * 1000);

function setup(outcome: (call: string, args: Record<string, unknown>) => WriteOutcome = () => ({ status: 'accepted', exchangeId: 'ex-1' })) {
 const db = openDb(':memory:'), clock = { now: t0 };
 const veto = createVetoWindowService(db, { internalActive: () => active as never }, { current: () => ({ openPositions: 0, realizedLossTodayUsdt: '0' }) }, () => clock.now);
 const intents = createExecutionIntentService(db, () => clock.now);
 const card = compileDemoCard(cardInput, () => t0).card!;
 veto.submit(card); veto.markDisplayed(card.contentSha256); clock.now = at(600); veto.settle(card.contentSha256);
 const intent = intents.consume(card.contentSha256);
 const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
 const writer: DemoWriter = {
  placeEntry: async (args) => { calls.push({ call: 'entry', args }); return outcome('entry', args); },
  placeAlgo: async (args) => { calls.push({ call: String(args.ordType), args }); return outcome(String(args.ordType), args); },
  cancelOrder: async (args) => { calls.push({ call: 'cancel', args }); return outcome('cancel', args); },
 };
 return { db, clock, card, intent, calls, executor: createDemoExecutor(db, writer, () => clock.now) };
}
const clean = { blockNewRisk: false, reasons: [] };
const fresh = (price = '100.5') => ({ priceUsdt: price, at: at(601).toISOString() });
const checks = (over: Record<string, unknown> = {}) => ({ reconciliation: clean, quote: fresh(), maxQuoteAgeSeconds: 10, maxPriceDeviationPpm: 10_000, ...over });

test('an entry passes the pre-submit recheck, is recorded as sending, then sent once as a base-quantity market buy', async () => {
 const { db, clock, intent, calls, executor } = setup(); try {
  clock.now = at(602);
  const result = await executor.submitEntry(intent.intentId, checks());
  assert.deepEqual([result.status, result.exchangeId], ['accepted', 'ex-1']);
  assert.deepEqual(calls[0], { call: 'entry', args: { instId: 'BTC-USDT', tdMode: 'cash', side: 'buy', ordType: 'market', sz: '0.2328', tgtCcy: 'base_ccy', clOrdId: intent.actions[0]!.clientOrderId } });
  // A second call never sends again; it returns the recorded outcome.
  assert.deepEqual(await executor.submitEntry(intent.intentId, checks()), result);
  assert.equal(calls.length, 1);
  // Even with a stale quote, the recorded outcome is reported rather than a fresh recheck verdict.
  assert.deepEqual(await executor.submitEntry(intent.intentId, checks({ quote: { priceUsdt: '100', at: at(1).toISOString() } })), result);
 } finally { db.close(); }
});

test('the pre-submit recheck blocks on a reconciliation block, a stale or moved quote, or an expired card, without sending', async () => {
 const { db, clock, intent, calls, executor } = setup(); try {
  clock.now = at(602);
  const blocked = async (over: Record<string, unknown>) => (await executor.submitEntry(intent.intentId, checks(over))).reasons;
  assert.deepEqual(await blocked({ reconciliation: { blockNewRisk: true, reasons: ['reconcile.unmanaged_order'] } }), ['execution.account_blocked']);
  assert.deepEqual(await blocked({ quote: { priceUsdt: '100.5', at: at(580).toISOString() } }), ['execution.quote_stale']);
  // 102 is 2% above the 100 reference, beyond the 1% allowed.
  assert.deepEqual(await blocked({ quote: fresh('102') }), ['execution.price_moved']);
  clock.now = new Date('2026-11-02T09:00:06Z');
  assert.deepEqual(await blocked({ quote: { priceUsdt: '100', at: '2026-11-02T09:00:05Z' } }), ['execution.card_expired']);
  assert.equal(calls.length, 0);
 } finally { db.close(); }
});

test('a timeout leaves the entry unknown and it is never resent; a definite rejection is recorded with its code', async () => {
 const unknown = setup(() => ({ status: 'unknown' })); try {
  unknown.clock.now = at(602);
  assert.equal((await unknown.executor.submitEntry(unknown.intent.intentId, checks())).status, 'unknown');
  assert.equal((await unknown.executor.submitEntry(unknown.intent.intentId, checks())).status, 'unknown');
  assert.equal(unknown.calls.length, 1);
 } finally { unknown.db.close(); }
 const rejected = setup(() => ({ status: 'rejected', code: '51008' })); try {
  rejected.clock.now = at(602);
  assert.deepEqual(await rejected.executor.submitEntry(rejected.intent.intentId, checks()), { status: 'rejected', exchangeId: null, code: '51008', reasons: [] });
 } finally { rejected.db.close(); }
});

test('protection is sized from the filled base quantity net of a base-coin fee and placed once each', async () => {
 const { db, clock, card, intent, calls, executor } = setup(); try {
  clock.now = at(602); await executor.submitEntry(intent.intentId, checks());
  // Filled 0.2328 BTC, fee -0.0002328 BTC: 0.2325672 held, rounded down to the 0.0001 lot.
  const placed = await executor.placeProtection(intent.intentId, { accFillSz: '0.2328', fee: '-0.0002328', feeCcy: 'BTC', lotSz: '0.0001' });
  assert.deepEqual(placed.map(p => [p.role, p.status]), [['initial_stop', 'accepted'], ['trailing_stop', 'accepted']]);
  assert.deepEqual(calls.slice(1).map(c => c.args), [
   { instId: 'BTC-USDT', tdMode: 'cash', side: 'sell', ordType: 'conditional', sz: '0.2325', slTriggerPx: card.protection.initialStopPriceUsdt, slOrdPx: '-1', algoClOrdId: intent.actions[1]!.clientOrderId },
   { instId: 'BTC-USDT', tdMode: 'cash', side: 'sell', ordType: 'move_order_stop', sz: '0.2325', callbackSpread: card.protection.trailing.callbackSpreadUsdt, algoClOrdId: intent.actions[2]!.clientOrderId },
  ]);
  await executor.placeProtection(intent.intentId, { accFillSz: '0.2328', fee: '-0.0002328', feeCcy: 'BTC', lotSz: '0.0001' });
  assert.equal(calls.length, 3);
 } finally { db.close(); }
});

test('protection is refused before an accepted entry, and sending records cannot be rewritten', async () => {
 const { db, clock, intent, executor } = setup(); try {
  clock.now = at(602);
  await assert.rejects(executor.placeProtection(intent.intentId, { accFillSz: '0.2328', fee: '0', feeCcy: 'USDT', lotSz: '0.0001' }), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'execution.entry_not_accepted');
  await executor.submitEntry(intent.intentId, checks());
  assert.throws(() => db.prepare('DELETE FROM execution_submissions').run());
 } finally { db.close(); }
});

test('a disposition lock blocks every new entry; cancel and exit are sent once and touch only this intent', async () => {
 const { db, clock, intent, calls, executor } = setup(); try {
  clock.now = at(602); await executor.submitEntry(intent.intentId, checks());
  executor.lockNewRisk(intent.intentId, 'protection_missing');
  assert.deepEqual(executor.riskLocks().map(l => [l.intentId, l.reason]), [[intent.intentId, 'protection_missing']]);
  const cancel = await executor.cancelRemainingEntry(intent.intentId);
  const exit = await executor.exitIntentExposure(intent.intentId, { heldQty: '0.23256', lotSz: '0.0001' });
  assert.deepEqual([cancel.status, exit.status], ['accepted', 'accepted']);
  assert.deepEqual(calls.slice(1).map(c => [c.call, c.args]), [
   ['cancel', { instId: 'BTC-USDT', clOrdId: intent.actions[0]!.clientOrderId }],
   ['entry', { instId: 'BTC-USDT', tdMode: 'cash', side: 'sell', ordType: 'market', sz: '0.2325', tgtCcy: 'base_ccy', clOrdId: exit.clientOrderId }],
  ]);
  assert.match(exit.clientOrderId, /^tax[0-9a-f]{28}$/);
  await executor.exitIntentExposure(intent.intentId, { heldQty: '0.23256', lotSz: '0.0001' }); await executor.cancelRemainingEntry(intent.intentId);
  assert.equal(calls.length, 3);
  assert.throws(() => db.prepare('DELETE FROM execution_risk_locks').run());
 } finally { db.close(); }
});

test('while any risk lock exists, the pre-submit recheck refuses new entries', async () => {
 const { db, clock, intent, calls, executor } = setup(); try {
  clock.now = at(602);
  executor.lockNewRisk('intent_other', 'protection_missing');
  assert.deepEqual((await executor.submitEntry(intent.intentId, checks())).reasons, ['execution.risk_locked']);
  assert.equal(calls.length, 0);
 } finally { db.close(); }
});

test('an exit below one lot is refused and sends nothing', async () => {
 const { db, clock, intent, calls, executor } = setup(); try {
  clock.now = at(602); await executor.submitEntry(intent.intentId, checks());
  await assert.rejects(executor.exitIntentExposure(intent.intentId, { heldQty: '0.00005', lotSz: '0.0001' }), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'execution.nothing_to_exit');
  assert.equal(calls.length, 1);
 } finally { db.close(); }
});
