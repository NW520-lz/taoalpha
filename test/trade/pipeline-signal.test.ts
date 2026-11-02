import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineSignal, PIPELINE_STRATEGY } from '../../src/trade/pipeline-signal.ts';

const H4 = 4 * 3_600_000;
// 16 closed 4H candles; each true range is high - low = 10, so ATR(14) = 10. Synthetic prices.
const candles = Array.from({ length: 16 }, (_, i) => ({ ts: i * H4, closeTime: (i + 1) * H4, open: '100', high: '105', low: '95', close: '100', confirmed: true }));

test('the pipeline signal uses ATR(14) of closed 4H candles and is labelled as a pipeline check', () => {
 const signal = pipelineSignal({ instId: 'BTC-USDT', candles, evidenceRef: 'bundle_synthetic' });
 assert.deepEqual(signal, { instId: 'BTC-USDT', product: 'spot', direction: 'long', signalCloseAt: new Date(16 * H4).toISOString(), atrUsdt: '10', initialStopAtr: '2', trailingStopAtr: '3', evidenceRefs: ['bundle_synthetic'] });
 assert.match(PIPELINE_STRATEGY.entryRules, /not a trading strategy/);
});

test('an unconfirmed last candle is ignored, and too few closed candles give no signal', () => {
 const withOpen = [...candles, { ts: 16 * H4, closeTime: 17 * H4, open: '100', high: '200', low: '50', close: '150', confirmed: false }];
 assert.equal(pipelineSignal({ instId: 'BTC-USDT', candles: withOpen, evidenceRef: 'bundle_synthetic' })!.atrUsdt, '10');
 assert.equal(pipelineSignal({ instId: 'BTC-USDT', candles: candles.slice(0, 14), evidenceRef: 'bundle_synthetic' }), null);
});
