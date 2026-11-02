import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { runDemoCycle, type CycleDeps } from '../../src/trade/demo-cycle.ts';

const H4 = 4 * 3_600_000, START = Date.parse('2026-11-03T08:00:05Z');
const page = (endpoint: string, rows: Record<string, unknown>[] = []) => ({ status: 'ok' as const, pages: [{ endpoint, requestTime: new Date(START).toISOString(), rows }] });
const grant = { version: 1, environment: 'demo' as const, strategy: { id: 'pipeline-test', version: 1 }, instruments: [{ instId: 'BTC-USDT', product: 'spot' as const }],
 limits: { maxPlanLossUsdtPerCard: '1', maxCardsPerDay: 2, dailyLossLimitUsdt: '3', maxOpenPositions: 1 }, riskPolicyVersion: 1, vetoWindowSeconds: 60, validUntil: '2026-12-01T00:00:00Z' };

function deps(decision: 'elapsed' | 'rejected') {
 const db = openDb(':memory:'), clock = { now: START };
 const sent: Array<Record<string, string>> = [];
 const d: CycleDeps = {
  db, now: () => new Date(clock.now), sleep: async (ms) => { clock.now += ms; }, log: () => {},
  refreshSession: async () => true,
  activeGrant: () => ({ proposalId: 'grant:one', subjectHash: 'a'.repeat(64), scopeId: 'scope:demo', accountRef: 'account:demo', site: 'global', confirmedAt: '2026-11-03T07:00:00Z', grant }),
  riskPolicy: () => ({ version: 1, spotBudgetUsdt: '30', perpetualBudgetUsdt: '0', maxSpotAssets: 1, maxPerpetualPositions: 0, maxSpotPlanLossUsdt: '5', maxPerpetualPlanLossUsdt: '0', maxPerpetualLeverage: '1' }),
  // 16 closed synthetic 4H candles with true range 10, and a fresh quote at 100.
  market: async () => ({ candles: Array.from({ length: 16 }, (_, i) => ({ ts: START - (17 - i) * H4, closeTime: START - (16 - i) * H4, open: '100', high: '105', low: '95', close: '100', confirmed: true })),
   quote: { priceUsdt: '100', at: new Date(clock.now).toISOString(), sourceRef: 'ticker:synthetic' },
   instrument: { instId: 'BTC-USDT', product: 'spot', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', listTime: null, tickSz: '0.1', lotSz: '0.0001', minSz: '0.001', ctVal: null } }),
  readAccount: async () => {
   const live = sent.filter(a => a.ordType === 'conditional' || a.ordType === 'move_order_stop').map(a => ({ instId: 'BTC-USDT', algoClOrdId: a.algoClOrdId, state: 'live' }));
   const bought = sent.some(a => a.side === 'buy');
   return { snapshot: { scope: { scopeId: 'scope:demo', site: 'global', environment: 'demo' }, accountReadComplete: true, reconciled: false, executionAuthorized: false, missing: [] as never,
     parts: { config: page('c'), balance: page('b'), positions: page('p'), spotOrders: page('o'), perpetualOrders: page('o'), spotProtection: page('a', live), perpetualProtection: page('a'), bills: page('bl'), fills: page('f') } } as never,
    account: { ok: true, readsComplete: true, account: { positions: [], equity: { assets: bought ? [{ currency: 'BTC', equity: { amount: '0.0493', unit: 'coin' } }] : [] } } } as never,
    orderByClientId: async (_inst, clOrdId) => ({ status: 'found' as const, row: { clOrdId, state: 'filled', accFillSz: '0.0493', fee: '-0.0000493', feeCcy: 'BTC' } }) };
  },
  display: { show: async (_card, onShown) => { onShown(); return decision; } },
  openWriter: async () => ({ close: async () => {},
   placeEntry: async (a) => { sent.push(a); return { status: 'accepted', exchangeId: 'o-1' }; },
   placeAlgo: async (a) => { sent.push(a); return { status: 'accepted', exchangeId: 'a-' + sent.length }; },
   cancelOrder: async (a) => { sent.push(a); return { status: 'accepted', exchangeId: 'c' }; } }),
 };
 return { d, db, sent };
}

test('an unrejected pipeline card is approved after its window, filled, protected and reconciled', async () => {
 const { d, db, sent } = deps('elapsed'); try {
  const report = await runDemoCycle(d) as { stage: string; reasons: string[]; protection?: unknown; reconciled?: boolean };
  assert.deepEqual([report.stage, report.reasons, report.protection, report.reconciled], ['done', [], [{ role: 'initial_stop', status: 'accepted' }, { role: 'trailing_stop', status: 'accepted' }], true]);
  // 1 / (20 + 180 x 0.15%) = 0.0493 BTC; the fee leaves 0.0492507, so protection covers 0.0492.
  assert.deepEqual(sent.map(a => [a.side, a.ordType, a.sz]), [['buy', 'market', '0.0493'], ['sell', 'conditional', '0.0492'], ['sell', 'move_order_stop', '0.0492']]);
  assert.equal(sent[1]!.slTriggerPx, '80');
 } finally { db.close(); }
});

test('a rejected card voids without sending anything', async () => {
 const { d, db, sent } = deps('rejected'); try {
  assert.deepEqual(await runDemoCycle(d), { stage: 'veto', reasons: ['cycle.user_rejected'] });
  assert.equal(sent.length, 0);
 } finally { db.close(); }
});

test('a grant read that fails (e.g. an expired account snapshot) counts as no grant: no crash, nothing sent', async () => {
 const { d, db, sent } = deps('elapsed'); try {
  let calls = 0; const real = d.activeGrant;
  d.activeGrant = () => { if (++calls > 1) throw new Error('snapshot expired'); return real(); };
  const report = await runDemoCycle(d);
  assert.deepEqual([report.stage, report.reasons], ['veto', ['veto.no_active_grant']]);
  assert.equal(sent.length, 0);
 } finally { db.close(); }
});

test('the session is refreshed before the card is submitted, before it is shown and before the window is settled', async () => {
 const { d, db } = deps('elapsed'); try {
  const order: string[] = []; const show = d.display.show;
  d.refreshSession = async () => { order.push('refresh'); return true; };
  d.display = { show: (card, onShown) => { order.push('show'); return show(card, onShown); } };
  await runDemoCycle(d);
  assert.deepEqual(order.slice(0, 4), ['refresh', 'refresh', 'refresh', 'show']);
  assert.equal(order[4], 'refresh');
 } finally { db.close(); }
});
