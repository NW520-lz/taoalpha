import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { compileDemoCard } from '../../src/trade/trade-card.ts';
import { createVetoWindowService } from '../../src/trade/veto-window.ts';

const t0 = new Date('2026-11-02T08:00:05Z');
const cardInput = { scope: { scopeId: 'scope:synthetic', accountRef: 'account:synthetic', site: 'global', environment: 'demo' },
 strategy: { id: 'breakout-atr-trailing', version: 2, validation: 'unvalidated' },
 signal: { instId: 'BTC-USDT', product: 'spot', direction: 'long', signalCloseAt: '2026-11-02T08:00:00Z', atrUsdt: '2', initialStopAtr: '2', trailingStopAtr: '3', evidenceRefs: ['ev_synthetic'] },
 quote: { priceUsdt: '100', at: '2026-11-02T08:00:04Z', sourceRef: 'quote:synthetic', maxAgeSeconds: 30 },
 instrument: { instId: 'BTC-USDT', product: 'spot', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', listTime: null, tickSz: '0.1', lotSz: '0.0001', minSz: '0.001', ctVal: null },
 costModel: { feePpm: 1000, slippagePpm: 500, assumptionRef: 'costs:synthetic' },
 riskPolicy: { version: 1, spotBudgetUsdt: '30', perpetualBudgetUsdt: '0', maxSpotAssets: 2, maxPerpetualPositions: 0, maxSpotPlanLossUsdt: '5', maxPerpetualPlanLossUsdt: '0', maxPerpetualLeverage: '1' },
 maxPlanLossUsdt: '1', portfolio: { accountReconciled: true, lossLedgerBlocksNewRisk: false, commitments: [] }, validForSeconds: 3600 };
const card = (over: Record<string, unknown> = {}, at = t0) => compileDemoCard({ ...cardInput, ...over }, () => at).card!;
const grant = { version: 1, environment: 'demo', strategy: { id: 'breakout-atr-trailing', version: 2 }, instruments: [{ instId: 'BTC-USDT', product: 'spot' }],
 limits: { maxPlanLossUsdtPerCard: '1', maxCardsPerDay: 2, dailyLossLimitUsdt: '3', maxOpenPositions: 1 }, riskPolicyVersion: 1, vetoWindowSeconds: 600, validUntil: '2026-12-01T00:00:00Z' };

function setup(limits: Record<string, unknown> = {}) {
 const db = openDb(':memory:');
 let now = t0, active: unknown = { proposalId: 'grant:one', subjectHash: 'a'.repeat(64), scopeId: 'scope:synthetic', accountRef: 'account:synthetic', site: 'global', confirmedAt: '2026-11-01T00:00:00Z', grant: { ...grant, limits: { ...grant.limits, ...limits } } };
 const exposure = { openPositions: 0, realizedLossTodayUsdt: '0' };
 const service = createVetoWindowService(db, { internalActive: () => active as never }, { current: () => exposure }, () => now);
 return { db, service, exposure, setNow: (d: Date) => { now = d; }, setActive: (a: unknown) => { active = a; } };
}
const after = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

test('a card inside the grant is approved once its displayed window ends without a rejection', () => {
 const { db, service, setNow } = setup(); try {
  const c = card();
  assert.deepEqual(service.submit(c), { cardHash: c.contentSha256, status: 'awaiting_display', reasons: [] });
  assert.equal(service.settle(c.contentSha256).status, 'awaiting_display');
  setNow(after(10)); assert.equal(service.markDisplayed(c.contentSha256).windowEndsAt, '2026-11-02T08:10:15.000Z');
  setNow(after(609)); assert.equal(service.settle(c.contentSha256).status, 'in_window');
  setNow(after(610));
  const settled = service.settle(c.contentSha256);
  assert.deepEqual([settled.status, settled.approval?.kind, settled.approval?.grantSubjectHash, settled.approval?.windowStartedAt], ['approved', 'standing_authorization_veto_window', 'a'.repeat(64), '2026-11-02T08:00:15.000Z']);
  assert.deepEqual(service.settle(c.contentSha256), settled);
 } finally { db.close(); }
});

test('a rejection inside the window or before display voids the card; after the window it is refused', () => {
 const { db, service, setNow } = setup({ maxCardsPerDay: 5 }); try {
  const inWindow = card(), early = card({ maxPlanLossUsdt: '0.9' }), late = card({ maxPlanLossUsdt: '0.8' });
  for (const c of [inWindow, early, late]) service.submit(c);
  service.markDisplayed(inWindow.contentSha256); service.markDisplayed(late.contentSha256);
  setNow(after(300));
  assert.equal(service.reject(inWindow.contentSha256).status, 'rejected');
  assert.equal(service.reject(early.contentSha256).status, 'rejected');
  setNow(after(600));
  assert.throws(() => service.reject(late.contentSha256), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'veto.window_closed');
  setNow(after(1200));
  assert.deepEqual([service.settle(inWindow.contentSha256).status, service.settle(early.contentSha256).status, service.settle(late.contentSha256).status], ['rejected', 'rejected', 'approved']);
  assert.throws(() => service.markDisplayed(early.contentSha256));
 } finally { db.close(); }
});

const rules = (r: { reasons: string[] }) => r.reasons;
test('cards outside the active grant never enter a window, and the reasons are listed', () => {
 const { db, service, exposure, setActive, setNow } = setup(); try {
  assert.deepEqual(rules(service.submit(card({ signal: { ...cardInput.signal, instId: 'ETH-USDT' }, instrument: { ...cardInput.instrument, instId: 'ETH-USDT', baseCcy: 'ETH' } }))), ['veto.instrument']);
  assert.deepEqual(rules(service.submit(card({ strategy: { ...cardInput.strategy, version: 3 } }))), ['veto.strategy']);
  assert.deepEqual(rules(service.submit(card({ riskPolicy: { ...cardInput.riskPolicy, version: 2 } }))), ['veto.risk_policy_version']);
  assert.deepEqual(rules(service.submit(card({ maxPlanLossUsdt: '2', riskPolicy: { ...cardInput.riskPolicy, spotBudgetUsdt: '100' } }))), ['veto.plan_loss']);
  assert.deepEqual(rules(service.submit(card({ scope: { ...cardInput.scope, accountRef: 'account:other' } }))), ['veto.account_scope']);
  exposure.openPositions = 1; assert.deepEqual(rules(service.submit(card())), ['veto.open_positions']); exposure.openPositions = 0;
  exposure.realizedLossTodayUsdt = '3'; assert.deepEqual(rules(service.submit(card())), ['veto.daily_loss_limit']); exposure.realizedLossTodayUsdt = '0';
  // Two cards per UTC day: a third is out of scope, a rejected one does not count.
  const [a, b, c] = [card(), card({ maxPlanLossUsdt: '0.9' }), card({ maxPlanLossUsdt: '0.8' })];
  service.submit(a); service.submit(b); assert.deepEqual(rules(service.submit(c)), ['veto.daily_card_limit']);
  service.reject(b.contentSha256); assert.equal(service.submit(c).status, 'awaiting_display');
  setNow(new Date('2026-11-02T09:00:06Z')); // That card was compiled at t0 and expired at 09:00:05; the day already holds two live cards.
  assert.deepEqual(rules(service.submit(card({ maxPlanLossUsdt: '0.7' }))), ['veto.card_expired', 'veto.daily_card_limit']);
  setActive(null); assert.deepEqual(rules(service.submit(card({ maxPlanLossUsdt: '0.6' }))), ['veto.no_active_grant']);
  assert.throws(() => service.submit({ ...card(), baseQuantity: '9' }), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'veto.card_integrity');
  assert.throws(() => service.markDisplayed('0'.repeat(64)));
 } finally { db.close(); }
});

test('settlement rechecks the grant, exposure and expiry; a voided card is never approved', () => {
 const { db, service, exposure, setActive, setNow } = setup({ maxCardsPerDay: 10 }); try {
  const base = { proposalId: 'grant:one', subjectHash: 'a'.repeat(64), scopeId: 'scope:synthetic', accountRef: 'account:synthetic', site: 'global', confirmedAt: '2026-11-01T00:00:00Z', grant: { ...grant, limits: { ...grant.limits, maxCardsPerDay: 10 } } };
  const shown = (over: Record<string, unknown>) => { const c = card(over); service.submit(c); service.markDisplayed(c.contentSha256); return c.contentSha256; };
  const revoked = shown({ maxPlanLossUsdt: '0.9' }), superseded = shown({ maxPlanLossUsdt: '0.8' }), crowded = shown({ maxPlanLossUsdt: '0.7' });
  const expiring = (() => { const c = card({ maxPlanLossUsdt: '0.6', validForSeconds: 300 }); service.submit(c); service.markDisplayed(c.contentSha256); return c.contentSha256; })();
  setNow(after(600));
  setActive(null); assert.deepEqual([service.settle(revoked).status, service.settle(revoked).reasons], ['void', ['veto.no_active_grant']]);
  setActive({ ...base, proposalId: 'grant:two' }); assert.deepEqual(service.settle(superseded).reasons, ['veto.grant_changed']);
  setActive(base); exposure.openPositions = 1; assert.deepEqual(service.settle(crowded).reasons, ['veto.open_positions']); exposure.openPositions = 0;
  assert.deepEqual(service.settle(expiring).reasons, ['veto.card_expired']);
  // Void is permanent: a stale signal is not approved once conditions recover.
  assert.deepEqual([service.settle(crowded).status, service.settle(crowded).reasons], ['void', ['veto.open_positions']]);
  // Without an active grant, showing a submitted card does not start its window.
  const late = card({ maxPlanLossUsdt: '0.5' }); service.submit(late); setActive(null);
  assert.throws(() => service.markDisplayed(late.contentSha256), (e: { violations?: Array<{ ruleId: string }> }) => e.violations?.[0]?.ruleId === 'veto.no_active_grant');
 } finally { db.close(); }
});

test('pending cards list their remaining window, and stored window facts cannot be rewritten', () => {
 const { db, service, setNow } = setup({ maxCardsPerDay: 5 }); try {
  const refused = card({ maxPlanLossUsdt: '0.5' }); service.submit(refused); service.reject(refused.contentSha256);
  const waiting = card(), shown = card({ maxPlanLossUsdt: '0.9' });
  service.submit(waiting); service.submit(shown); service.markDisplayed(shown.contentSha256);
  setNow(after(120));
  assert.deepEqual(service.pending().map(p => [p.cardHash, p.status, p.secondsLeft]), [[waiting.contentSha256, 'awaiting_display', null], [shown.contentSha256, 'in_window', 480]]);
  assert.throws(() => db.prepare("UPDATE veto_displays SET window_ends_at='2026-11-02T08:00:06.000Z'").run());
  assert.throws(() => db.prepare('DELETE FROM veto_rejections').run());
  setNow(after(600)); service.settle(shown.contentSha256);
  assert.deepEqual(service.pending().map(p => p.cardHash), [waiting.contentSha256]);
 } finally { db.close(); }
});
