import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDemoAccount } from '../../src/account/demo-reconciliation.ts';

const page = (endpoint: string, rows: Record<string, unknown>[]) => ({ status: 'ok' as const, pages: [{ endpoint, requestTime: '2026-11-02T10:00:00Z', rows }] });
// Synthetic exchange rows only (OKX field names: clOrdId, algoClOrdId, accFillSz).
function snapshot(over: Record<string, unknown> = {}) {
 return { scope: { scopeId: 'scope:synthetic', site: 'global', environment: 'demo' }, accountReadComplete: true, reconciled: false, executionAuthorized: false, missing: ['capital_history', 'managed_ownership', 'auto_add_margin_verification'],
  parts: { config: page('GET /api/v5/account/config', []), balance: page('GET /api/v5/account/balance', []), positions: page('GET /api/v5/account/positions', []),
   spotOrders: page('GET /api/v5/trade/orders-pending', []), perpetualOrders: page('GET /api/v5/trade/orders-pending', []),
   spotProtection: page('GET /api/v5/trade/orders-algo-pending', []), perpetualProtection: page('GET /api/v5/trade/orders-algo-pending', []),
   bills: page('GET /api/v5/account/bills', []), fills: page('GET /api/v5/trade/fills', []), ...over } } as never;
}
const accountOk = { ok: true, readsComplete: true, account: { positions: [], equity: { assets: [] } } } as never;
const intent = { intentId: 'intent_one', instId: 'BTC-USDT', actions: [{ role: 'entry', clientOrderId: 'taeA' }, { role: 'initial_stop', clientOrderId: 'tasA' }, { role: 'trailing_stop', clientOrderId: 'tatA' }] };
const NOW = Date.parse('2026-11-02T10:00:00Z'), DAY = 86_400_000;
const full = (over: Record<string, unknown> = {}) => ({ snapshot: snapshot(), account: accountOk, intents: [intent], now: NOW,
 capital: { sinceMs: NOW - DAY, recordedBillIds: [] as string[] }, submittedIntentIds: [] as string[], entryLookups: {}, managedHoldings: {}, cleanCurrencies: {}, triggeredAlgoClientIds: [] as string[], ...over });

test('a complete read with only our own orders, each filled entry protected, does not block', () => {
 const snap = snapshot({ spotOrders: page('GET /api/v5/trade/orders-pending', [{ instId: 'BTC-USDT', clOrdId: 'taeA', state: 'partially_filled', accFillSz: '0.1' }]),
  spotProtection: page('GET /api/v5/trade/orders-algo-pending', [{ instId: 'BTC-USDT', algoClOrdId: 'tasA', state: 'live' }, { instId: 'BTC-USDT', algoClOrdId: 'tatA', state: 'live' }]) });
 const result = reconcileDemoAccount(full({ snapshot: snap }) as never);
 assert.deepEqual([result.blockNewRisk, result.reasons, result.unmanagedOrders], [false, [], 0]);
 assert.deepEqual(result.intents, [{ intentId: 'intent_one', entry: 'partially_filled', initialStop: 'live', trailingStop: 'live' }]);
 // With no blocking discrepancy and every fact read, the account is reconciled.
 assert.deepEqual([result.accountReconciled, result.gaps], [true, []]);
});

test('incomplete reads, foreign orders, perpetual positions and a filled entry without a stop all block', () => {
 const reasons = (snap: unknown, account: unknown = accountOk) => reconcileDemoAccount(full({ snapshot: snap, account }) as never).reasons;
 assert.deepEqual(reasons(snapshot({ balance: { status: 'unavailable', reason: 'read_failed_or_incomplete' } })), ['reconcile.read_incomplete']);
 assert.deepEqual(reasons(snapshot(), { ok: false, readsComplete: true }), ['reconcile.read_incomplete']);
 assert.deepEqual(reasons(snapshot({ spotOrders: page('GET /api/v5/trade/orders-pending', [{ instId: 'ETH-USDT', clOrdId: 'manual1', state: 'live', accFillSz: '0' }]) })), ['reconcile.unmanaged_order']);
 assert.deepEqual(reasons(snapshot({ perpetualProtection: page('GET /api/v5/trade/orders-algo-pending', [{ instId: 'BTC-USDT-SWAP', algoClOrdId: '', state: 'live' }]) })), ['reconcile.unmanaged_order']);
 assert.deepEqual(reasons(snapshot(), { ok: true, readsComplete: true, account: { positions: [{ instrumentId: 'BTC-USDT-SWAP', contracts: '1' }], equity: { assets: [] } } }), ['reconcile.unmanaged_position']);
 assert.deepEqual(reasons(snapshot({ spotOrders: page('GET /api/v5/trade/orders-pending', [{ instId: 'BTC-USDT', clOrdId: 'taeA', state: 'partially_filled', accFillSz: '0.1' }]) })), ['reconcile.protection_missing']);
});


test('transfers since the last full reconciliation must already be recorded, within the 7-day bill window', () => {
 const bills = (rows: Record<string, unknown>[]) => snapshot({ bills: page('GET /api/v5/account/bills', rows) });
 const transfer = { billId: 'b1', type: '1', ts: String(NOW - 3_600_000) };
 assert.deepEqual(reconcileDemoAccount(full({ snapshot: bills([transfer]) }) as never).reasons, ['reconcile.capital_event_unrecorded']);
 assert.deepEqual(reconcileDemoAccount(full({ snapshot: bills([transfer]), capital: { sinceMs: NOW - DAY, recordedBillIds: ['b1'] } }) as never).reasons, []);
 // Trades and transfers before the reconciliation start do not count.
 assert.deepEqual(reconcileDemoAccount(full({ snapshot: bills([{ billId: 'b2', type: '2', ts: String(NOW) }, { billId: 'b3', type: '1', ts: String(NOW - 2 * DAY) }]) }) as never).reasons, []);
 assert.deepEqual(reconcileDemoAccount(full({ capital: { sinceMs: NOW - 8 * DAY, recordedBillIds: [] } }) as never).reasons, ['reconcile.capital_window_exceeded']);
});

test('a submitted entry missing from open orders needs a lookup: filled without a stop or unknown to the exchange blocks', () => {
 const submitted = (lookup: unknown) => reconcileDemoAccount(full({ submittedIntentIds: ['intent_one'], entryLookups: lookup === undefined ? {} : { intent_one: lookup } }) as never).reasons;
 assert.deepEqual(submitted(undefined), ['reconcile.entry_lookup_missing']);
 assert.deepEqual(submitted({ status: 'not_found' }), ['reconcile.submitted_entry_unknown']);
 assert.deepEqual(submitted({ status: 'found', row: { clOrdId: 'taeA', state: 'filled', accFillSz: '0.2' } }), ['reconcile.protection_missing']);
 assert.deepEqual(submitted({ status: 'found', row: { clOrdId: 'taeA', state: 'canceled', accFillSz: '0' } }), []);
 const r = reconcileDemoAccount(full() as never);
 assert.deepEqual([r.reasons, r.gaps, r.accountReconciled], [[], [], true]);
});

test('managed spot holdings must be covered by the coin balance; extra coins are unmanaged and ignored', () => {
 const withBalance = (eq: string) => ({ ok: true, readsComplete: true, account: { positions: [], equity: { assets: [{ currency: 'BTC', equity: { amount: eq, unit: 'coin' } }] } } });
 const run = (eq: string, managed: Record<string, string>) => reconcileDemoAccount(full({ account: withBalance(eq), managedHoldings: managed }) as never);
 const ok = run('0.5', { BTC: '0.2325' });
 assert.deepEqual([ok.reasons, ok.gaps, ok.accountReconciled], [[], [], true]);
 assert.deepEqual(run('0.2', { BTC: '0.2325' }).reasons, ['reconcile.managed_holding_missing']);
 assert.deepEqual(run('0', { ETH: '1' }).reasons, ['reconcile.managed_holding_missing']);
});

test('a granted base currency may hold only managed coins (plus sub-minimum dust), so a second stop can never sell other coins', () => {
 const withBalance = (eq: string) => ({ ok: true, readsComplete: true, account: { positions: [], equity: { assets: [{ currency: 'BTC', equity: { amount: eq, unit: 'coin' } }] } } });
 const run = (eq: string, managed: Record<string, string>) => reconcileDemoAccount(full({ account: withBalance(eq), managedHoldings: managed, cleanCurrencies: { BTC: '0.00001' } }) as never).reasons;
 assert.deepEqual(run('0.2325', { BTC: '0.2325' }), []);
 assert.deepEqual(run('0.232505', { BTC: '0.2325' }), []);
 assert.deepEqual(run('1.2325', { BTC: '0.2325' }), ['reconcile.unmanaged_holding']);
 assert.deepEqual(run('0.5', {}), ['reconcile.unmanaged_holding']);
});

test('an intent whose initial or trailing stop triggered has exited: no missing-protection block and no managed holding', () => {
 const filled = { status: 'found', row: { clOrdId: 'taeA', state: 'filled', accFillSz: '0.2', fee: '0', feeCcy: 'USDT' } };
 const r = reconcileDemoAccount(full({ submittedIntentIds: ['intent_one'], entryLookups: { intent_one: filled }, triggeredAlgoClientIds: ['tasA'] }) as never);
 assert.deepEqual([r.reasons, r.intents[0]!.initialStop, r.exitedIntentIds], [[], 'triggered', ['intent_one']]);
});
