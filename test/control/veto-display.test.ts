import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVetoDisplay } from '../../src/control/veto-display.ts';

// A fake window process: emits the given stdout lines, recording what it was given on stdin.
function fakeRunner(lines: string[], fail = false) {
 const seen: { input?: string } = {};
 const run = async (input: string, onLine: (line: string) => void) => { seen.input = input; if (fail) throw new Error('spawn failed'); for (const l of lines) onLine(l); };
 return { run, seen };
}
const card = { title: 'BTC-USDT spot long (demo, pipeline check)', lines: ['数量 0.0004 BTC', '初始止损 76000'], seconds: 600 };

test('the window reports shown before any decision, and a rejection or close counts as a rejection', async () => {
 for (const [last, expected] of [['{"event":"rejected"}', 'rejected'], ['{"event":"closed"}', 'rejected'], ['{"event":"elapsed"}', 'elapsed']] as const) {
  const { run, seen } = fakeRunner(['{"event":"shown"}', last]);
  const shown: string[] = [];
  assert.equal(await createVetoDisplay({ platform: 'win32', run }).show(card, () => { shown.push('shown'); }), expected);
  assert.deepEqual([shown, JSON.parse(seen.input!)], [['shown'], card]);
 }
});

test('no shown event, a failed process, garbage output or another platform is unavailable and never shown', async () => {
 const cases = [fakeRunner(['{"event":"elapsed"}']), fakeRunner([], true), fakeRunner(['{"event":"shown"}', 'not json']), fakeRunner(['{"event":"shown"}'])];
 for (const { run } of cases) {
  let shown = 0;
  const result = await createVetoDisplay({ platform: 'win32', run }).show(card, () => { shown++; });
  assert.ok(result === 'unavailable', result);
 }
 assert.equal(await createVetoDisplay({ platform: 'linux', run: fakeRunner(['{"event":"shown"}']).run }).show(card, () => {}), 'unavailable');
});
