import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDemoCard } from '../../src/trade/trade-card.ts';

const now = () => new Date('2026-11-02T08:00:05Z');
// Synthetic market and limits only.
const input = (over: Record<string, unknown> = {}) => ({
 scope: { scopeId: 'scope:synthetic', accountRef: 'account:synthetic', site: 'global', environment: 'demo' },
 strategy: { id: 'breakout-atr-trailing', version: 2, validation: 'unvalidated' },
 signal: { instId: 'BTC-USDT', product: 'spot', direction: 'long', signalCloseAt: '2026-11-02T08:00:00Z', atrUsdt: '2', initialStopAtr: '2', trailingStopAtr: '3', evidenceRefs: ['ev_synthetic'] },
 quote: { priceUsdt: '100', at: '2026-11-02T08:00:04Z', sourceRef: 'quote:synthetic', maxAgeSeconds: 30 },
 instrument: { instId: 'BTC-USDT', product: 'spot', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', listTime: null, tickSz: '0.1', lotSz: '0.0001', minSz: '0.001', ctVal: null },
 costModel: { feePpm: 1000, slippagePpm: 500, assumptionRef: 'costs:synthetic' },
 riskPolicy: { version: 1, spotBudgetUsdt: '30', perpetualBudgetUsdt: '0', maxSpotAssets: 2, maxPerpetualPositions: 0, maxSpotPlanLossUsdt: '5', maxPerpetualPlanLossUsdt: '0', maxPerpetualLeverage: '1' },
 maxPlanLossUsdt: '1',
 portfolio: { accountReconciled: true, lossLedgerBlocksNewRisk: false, commitments: [] },
 validForSeconds: 900,
 ...over,
});

test('a demo card sizes the entry from the plan-loss limit and freezes stop and trailing distance', () => {
 const result = compileDemoCard(input(), now);
 assert.equal(result.outcome, 'compiled');
 const card = result.card!;
 // Per unit: price loss 100 - 96 = 4, costs (100 + 96) x 0.15% = 0.294; 1 / 4.294 rounds down to 0.2328.
 assert.deepEqual([card.baseQuantity, card.protection.initialStopPriceUsdt, card.protection.trailing.callbackSpreadUsdt], ['0.2328', '96', '6']);
 assert.deepEqual([card.risk.plannedLossUsdt, card.risk.feesUsdt, card.risk.slippageUsdt, card.risk.notionalUsdt], ['0.9996432', '0.0456288', '0.0228144', '23.28']);
 assert.deepEqual([card.environment, card.strategy.validation, card.label, card.executable, card.expiresAt], ['demo', 'unvalidated', 'pipeline_test_unvalidated_strategy', false, '2026-11-02T08:15:05.000Z']);
 assert.equal(card.exceptionPolicy.protectionMissingOrUnknown, 'lock_new_risk_cancel_remaining_entry_exit_this_intent_exposure');
 assert.equal(compileDemoCard(input(), now).card!.contentSha256, card.contentSha256);
 assert.notEqual(compileDemoCard(input({ maxPlanLossUsdt: '0.9' }), now).card!.contentSha256, card.contentSha256);
});

test('a stale quote, an unreconciled account, a too-small size or an over-budget plan yields no card', () => {
 const reasons = (over: Record<string, unknown>) => { const r = compileDemoCard(input(over), now); assert.equal(r.card, null); assert.equal(r.outcome, 'blocked'); return r.reasons; };
 assert.deepEqual(reasons({ quote: { priceUsdt: '100', at: '2026-11-02T08:00:00Z', sourceRef: 'quote:synthetic', maxAgeSeconds: 4 } }), ['card.quote_stale']);
 assert.ok(reasons({ portfolio: { accountReconciled: false, lossLedgerBlocksNewRisk: false, commitments: [] } }).includes('entry.account_reconciled'));
 // 0.004 / 4.294 rounds down to 0.0009, below the 0.001 minimum.
 assert.ok(reasons({ maxPlanLossUsdt: '0.004' }).includes('entry.minimum_quantity'));
 assert.ok(reasons({ riskPolicy: { ...input().riskPolicy as object, spotBudgetUsdt: '20' } }).includes('entry.spot_budget'));
});

test('only demo cards exist, and the signal must name the instrument it is priced on', () => {
 const invalid = (over: Record<string, unknown>) => assert.throws(() => compileDemoCard(input(over), now), (e: { code?: string }) => e.code === 'INVALID_INPUT');
 invalid({ scope: { scopeId: 'scope:synthetic', accountRef: 'account:synthetic', site: 'global', environment: 'live' } });
 invalid({ signal: { ...input().signal as object, instId: 'ETH-USDT' } });
});

test('a quote up to 10 seconds ahead of the local clock is accepted as clock skew; further ahead is stale', () => {
 const ahead = (s: number) => compileDemoCard(input({ quote: { priceUsdt: '100', at: new Date(now().getTime() + s * 1000).toISOString(), sourceRef: 'quote:synthetic', maxAgeSeconds: 30 } }), now);
 assert.equal(ahead(5).outcome, 'compiled');
 assert.deepEqual(ahead(15).reasons, ['card.quote_stale']);
});
