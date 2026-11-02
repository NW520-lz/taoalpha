import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVetoDisplay } from '../../src/control/veto-display.ts';

type Sent = { title: string; lines: string[]; labels: { window: string; reject: string; countdown: string } };
// The text a correct window puts on screen, hashed the way the window script reports it.
const shownHash = (sent: Sent) => createHash('sha256').update([sent.title, ...sent.lines, sent.labels.window, sent.labels.reject, sent.labels.countdown].join('\n'), 'utf8').digest('hex');
// A fake window process: echoes the hash of what it received (or a wrong one), then the given events.
function fakeRunner(events: string[], options: { fail?: boolean; wrongHash?: boolean; noShown?: boolean } = {}) {
 const seen: { input?: string } = {};
 const run = async (input: string, onLine: (line: string) => void) => {
  seen.input = input; if (options.fail) throw new Error('spawn failed');
  const hash = options.wrongHash ? '0'.repeat(64) : shownHash(JSON.parse(input) as Sent);
  if (!options.noShown) onLine(JSON.stringify({ event: 'shown', textSha256: hash }));
  for (const e of events) onLine(e);
 };
 return { run, seen };
}
const card = { title: 'BTC-USDT 现货做多（模拟盘，管道验证）', lines: ['数量 0.0004 BTC', '初始止损 76000'], seconds: 600 };

test('the window gets every visible text as UTF-8 data, reports shown with a matching hash, and close counts as rejection', async () => {
 for (const [last, expected] of [['{"event":"rejected"}', 'rejected'], ['{"event":"closed"}', 'rejected'], ['{"event":"elapsed"}', 'elapsed']] as const) {
  const { run, seen } = fakeRunner([last]);
  let shown = 0;
  assert.equal(await createVetoDisplay({ platform: 'win32', run }).show(card, () => { shown++; }), expected);
  const sent = JSON.parse(seen.input!) as Sent & { seconds: number };
  assert.deepEqual([shown, sent.title, sent.lines, sent.seconds, sent.labels.reject], [1, card.title, card.lines, 600, '拒绝执行']);
 }
});

test('a hash mismatch (garbled text), no shown event, a failed process, garbage output or another platform is unavailable', async () => {
 const cases = [fakeRunner(['{"event":"elapsed"}'], { wrongHash: true }), fakeRunner(['{"event":"elapsed"}'], { noShown: true }), fakeRunner([], { fail: true }), fakeRunner(['not json']), fakeRunner([])];
 for (const { run } of cases) {
  let shown = 0;
  assert.equal(await createVetoDisplay({ platform: 'win32', run }).show(card, () => { shown++; }), 'unavailable');
 }
 // Garbled text never even starts the window.
 let started = 0;
 await createVetoDisplay({ platform: 'win32', run: fakeRunner(['{"event":"elapsed"}'], { wrongHash: true }).run }).show(card, () => { started++; });
 assert.equal(started, 0);
 assert.equal(await createVetoDisplay({ platform: 'linux', run: fakeRunner([]).run }).show(card, () => {}), 'unavailable');
});
