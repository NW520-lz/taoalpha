import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayGridCandles } from '../../src/research/grid-replay.ts';

const H = 3_600_000;
const free = { entryFeePpm: 0, exitFeePpm: 0, entryImpactPpm: 0, exitImpactPpm: 0, funding: 'not_applicable' } as const;
// Synthetic hourly bars as [open, high, low, close].
const bars = (rows: Array<[number, number, number, number]>) => rows.map(([o, h, l, c], i) => ({ ts: i * H, closeTime: (i + 1) * H, open: String(o), high: String(h), low: String(l), close: String(c) }));
const input = (rows: Array<[number, number, number, number]>, rule = {}, cost = {}) => ({
 schemaVersion: 1, resolutionMs: H, candles: bars(rows),
 market: { product: 'spot', quote: 'USDT', baseQuantity: '1' },
 rule: { kind: 'grid_spot', lowerPrice: '100', upperPrice: '120', gridCount: 2, spacing: 'arithmetic', stopPrice: '90', ...rule },
 cost: { ...free, ...cost },
});
const brief = (t: { entryIndex: number; exitIndex: number; exitReason: string; entryPrice: string; exitPrice: string; netUsdt: string }) => [t.entryIndex, t.exitIndex, t.exitReason, t.entryPrice, t.exitPrice, t.netUsdt];

test('a buy at a grid line is sold at the next line up in a later bar', () => {
 // Levels 100 / 110 / 120. Bar 0 dips to 109 (buys at 110); bar 1 reaches 121 (sells at 120).
 const result = replayGridCandles(input([[115, 116, 109, 112], [112, 121, 111, 118], [118, 119, 117, 118]]));
 assert.deepEqual(result.levels, ['100', '110', '120']);
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[0, 1, 'grid_sell', '110', '120', '10']]);
 assert.deepEqual([result.stoppedAtIndex, result.maxEquityDrawdownUsdt, result.executionAuthorized], [null, '0', false]);
});

test('a same-bar round trip is not counted, and open inventory drives the equity drawdown', () => {
 // Bar 0 touches both 109 and 121, but only the buy at 110 counts; bar 1 closes at 106 with the slot still held.
 const result = replayGridCandles(input([[115, 121, 109, 112], [112, 113, 105, 106]]));
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[0, 1, 'end_of_data', '110', '106', '-4']]);
 assert.deepEqual([result.maxEquityDrawdownUsdt, result.maxInventorySlots], ['6', 1]);
});

test('a buy line above the reference price waits until a close above it', () => {
 // Opens at 105: only the 100 line rests. The 110 line arms after bar 1 closes at 111.
 const result = replayGridCandles(input([[105, 106, 99, 104], [104, 112, 103, 111], [111, 112, 109, 110], [110, 111, 108, 109]]));
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[0, 1, 'grid_sell', '100', '110', '10'], [2, 3, 'end_of_data', '110', '109', '-1']]);
});

test('a bar reaching the stop fills every resting buy, sells everything at the stop and ends the grid', () => {
 // Bar 1 spans 85..125: the worst path goes down first, so the 120 sell never happens and the 100 buy does.
 const result = replayGridCandles(input([[115, 116, 109, 112], [112, 125, 85, 95], [95, 130, 94, 125]]));
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[1, 1, 'stop', '100', '90', '-10'], [0, 1, 'stop', '110', '90', '-20']]);
 assert.deepEqual([result.stoppedAtIndex, result.maxEquityDrawdownUsdt], [1, '32']);
});

test('an open below the stop fills the stop at that open', () => {
 const result = replayGridCandles(input([[115, 116, 109, 112], [88, 89, 80, 85]]));
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[1, 1, 'gap_through_stop', '100', '88', '-12'], [0, 1, 'gap_through_stop', '110', '88', '-22']]);
 assert.equal(result.stoppedAtIndex, 1);
});

test('costs apply once per side on notional, and geometric lines grow by a constant ratio', () => {
 const costly = replayGridCandles(input([[115, 116, 109, 112], [112, 121, 111, 118]], {}, { entryFeePpm: 1000, exitFeePpm: 1000, entryImpactPpm: 500, exitImpactPpm: 500 }));
 const [trade] = costly.hypotheticalTrades;
 assert.deepEqual([trade!.grossUsdt, trade!.feesUsdt, trade!.impactUsdt, trade!.netUsdt], ['10', '0.23', '0.115', '9.655']);
 assert.deepEqual(replayGridCandles(input([[150, 150, 150, 150]], { upperPrice: '144', gridCount: 2, spacing: 'geometric' })).levels, ['100', '120', '144']);
});

test('an inverted range or a stop inside it is rejected as invalid input', () => {
 for (const rule of [{ stopPrice: '100' }, { upperPrice: '100' }, { gridCount: 0 }]) {
  assert.throws(() => replayGridCandles(input([[115, 116, 109, 112]], rule)), (e: { code?: string }) => e.code === 'INVALID_INPUT');
 }
});
