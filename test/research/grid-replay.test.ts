import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayGridCandles } from '../../src/research/grid-replay.ts';

const H = 3_600_000;
const free = { entryFeePpm: 0, exitFeePpm: 0, entryImpactPpm: 0, exitImpactPpm: 0, funding: 'not_applicable' } as const;
// Synthetic hourly bars as [open, high, low, close].
const bars = (rows: Array<[number, number, number, number]>) => rows.map(([o, h, l, c], i) => ({ ts: i * H, closeTime: (i + 1) * H, open: String(o), high: String(h), low: String(l), close: String(c) }));
// Centred at the first open of 100: lines 80 / 100 / 120, stop 70.
const input = (rows: Array<[number, number, number, number]>, rule = {}, cost = {}) => ({
 schemaVersion: 1, resolutionMs: H, candles: bars(rows),
 market: { product: 'spot', quote: 'USDT', baseQuantity: '1' },
 rule: { kind: 'grid_spot', rangeFraction: '0.2', gridCount: 2, spacing: 'arithmetic', stopFraction: '0.3', ...rule },
 cost: { ...free, ...cost },
});
const brief = (t: { entryIndex: number; exitIndex: number; exitReason: string; entryPrice: string; exitPrice: string; netUsdt: string }) => [t.entryIndex, t.exitIndex, t.exitReason, t.entryPrice, t.exitPrice, t.netUsdt];
const centres = (r: ReturnType<typeof replayGridCandles>) => r.grids.map(g => [g.startIndex, g.centre]);

test('a grid centred on the first open buys at a line and sells at the next line up in a later bar', () => {
 const result = replayGridCandles(input([[100, 101, 79, 90], [90, 101, 85, 95]]));
 assert.deepEqual([result.grids[0]!.levels, result.grids[0]!.stopPrice], [['80', '100', '120'], '70']);
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[0, 1, 'grid_sell', '80', '100', '20']]);
 assert.deepEqual([result.stops, result.maxEquityDrawdownUsdt, result.executionAuthorized], [[], '0', false]);
});

test('a same-bar round trip is not counted, and open inventory drives the equity drawdown', () => {
 // Bar 0 touches 79 and 121, but only the buy at 80 counts; bar 1 closes at 76 with the slot still held.
 const result = replayGridCandles(input([[100, 121, 79, 90], [90, 95, 75, 76]]));
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[0, 1, 'end_of_data', '80', '76', '-4']]);
 assert.deepEqual([result.maxEquityDrawdownUsdt, result.maxInventorySlots], ['14', 1]);
});

test('a buy line at or above the reference price waits until a close above it', () => {
 // The 100 line equals the first open, so it rests only after bar 0 closes at 101.
 const result = replayGridCandles(input([[100, 101, 95, 101], [101, 102, 99, 101]]));
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[1, 1, 'end_of_data', '100', '101', '1']]);
});

test('a bar reaching the stop fills every resting buy, exits everything at the stop and re-centres next bar', () => {
 // Bar 1 spans 65..125: the worst path goes down first, so the 100 sell never happens and the 100 buy does.
 const result = replayGridCandles(input([[100, 106, 79, 105], [105, 125, 65, 72], [72, 73, 71, 72]]));
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[0, 1, 'stop', '80', '70', '-10'], [1, 1, 'stop', '100', '70', '-30']]);
 assert.deepEqual([result.stops, centres(result), result.maxEquityDrawdownUsdt], [[1], [[0, '100'], [2, '72']], '65']);
});

test('an open below the stop fills the stop at that open', () => {
 const result = replayGridCandles(input([[100, 106, 79, 105], [69, 70, 60, 65]]));
 assert.deepEqual(result.hypotheticalTrades.map(brief), [[0, 1, 'gap_through_stop', '80', '69', '-11'], [1, 1, 'gap_through_stop', '100', '69', '-31']]);
});

test('an empty grid re-centres when price leaves its range, but not while it holds inventory', () => {
 assert.deepEqual(centres(replayGridCandles(input([[100, 126, 99, 125], [125, 126, 124, 125]]))), [[0, '100'], [1, '125']]);
 const holding = replayGridCandles(input([[100, 126, 79, 125], [125, 126, 124, 125]]));
 assert.deepEqual([centres(holding), holding.hypotheticalTrades.map(brief)], [[[0, '100']], [[0, 1, 'grid_sell', '80', '100', '20']]]);
});

test('costs apply once per side on notional, and geometric lines grow by a constant ratio', () => {
 const costly = replayGridCandles(input([[100, 101, 79, 90], [90, 101, 85, 95]], {}, { entryFeePpm: 1000, exitFeePpm: 1000, entryImpactPpm: 500, exitImpactPpm: 500 }));
 const [trade] = costly.hypotheticalTrades;
 assert.deepEqual([trade!.grossUsdt, trade!.feesUsdt, trade!.impactUsdt, trade!.netUsdt], ['20', '0.18', '0.09', '19.73']);
 // Geometric between 80 and 120: the middle line is sqrt(80 x 120) = 97.97958971...
 const geometric = replayGridCandles(input([[100, 100, 100, 100]], { spacing: 'geometric' }));
 assert.deepEqual(geometric.grids[0]!.levels.map(l => Number(l).toFixed(6)), ['80.000000', '97.979590', '120.000000']);
});

test('a stop inside the range, a range of 100% or more, or no grid lines is rejected as invalid input', () => {
 for (const rule of [{ stopFraction: '0.2' }, { rangeFraction: '1', stopFraction: '1.1' }, { gridCount: 0 }]) {
  assert.throws(() => replayGridCandles(input([[100, 101, 99, 100]], rule)), (e: { code?: string }) => e.code === 'INVALID_INPUT');
 }
});
