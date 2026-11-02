import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRADE_KIT_VERSION, type TradeKitPeer } from '../../src/okx/trade-kit-demo-reader.ts';
import { createDemoWriteSession } from '../../src/okx/trade-kit-demo-writer.ts';

const scope = { scopeId: 'synthetic-demo-scope', site: 'global' as const, environment: 'demo' as const };
const endpoints: Record<string, string> = { spot_place_order: 'POST /api/v5/trade/order', spot_place_algo_order: 'POST /api/v5/trade/order-algo' };

function fakePeer(options: { demo?: boolean; readOnly?: boolean; version?: string; reply?: (name: string, args: Record<string, unknown>) => unknown } = {}) {
 const caps = { demo: options.demo ?? true, readOnly: options.readOnly ?? false, hasAuth: true };
 const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
 const peer: TradeKitPeer = {
  getServerVersion: () => ({ name: 'okx-trade-mcp', version: options.version ?? TRADE_KIT_VERSION }),
  listTools: async () => ({ tools: ['system_get_capabilities', ...Object.keys(endpoints)].map(name => ({ name })) }),
  callTool: async (input) => {
   calls.push(input);
   if (input.name === 'system_get_capabilities') return { structuredContent: { tool: input.name, ok: true, data: { server: { name: 'okx-trade-mcp', version: options.version ?? TRADE_KIT_VERSION }, capabilities: caps }, capabilities: caps } };
   const reply = options.reply?.(input.name, input.arguments);
   if (reply instanceof Error) throw reply;
   return reply ?? { structuredContent: { tool: input.name, ok: true, data: { endpoint: endpoints[input.name], requestTime: '2026-11-02T10:00:00Z', data: [input.name === 'spot_place_order' ? { ordId: 'o-1', clOrdId: input.arguments.clOrdId, sCode: '0' } : { algoId: 'a-1', algoClOrdId: input.arguments.algoClOrdId, sCode: '0' }] }, capabilities: caps } };
  },
 };
 return { peer, calls };
}
const entry = { instId: 'BTC-USDT', tdMode: 'cash', side: 'buy', ordType: 'market', sz: '0.001', tgtCcy: 'base_ccy', clOrdId: 'taeA' };

test('a verified demo writer maps accepted orders and algo orders to their exchange ids', async () => {
 const { peer, calls } = fakePeer();
 const writer = await createDemoWriteSession(peer, scope);
 assert.deepEqual(await writer.placeEntry(entry), { status: 'accepted', exchangeId: 'o-1' });
 assert.deepEqual(await writer.placeAlgo({ instId: 'BTC-USDT', side: 'sell', ordType: 'conditional', sz: '0.001', slTriggerPx: '90', slOrdPx: '-1', algoClOrdId: 'tasA' }), { status: 'accepted', exchangeId: 'a-1' });
 assert.deepEqual(calls.slice(1).map(c => c.name), ['spot_place_order', 'spot_place_algo_order']);
});

test('a non-demo, read-only or unpinned server is refused before any order', async () => {
 for (const options of [{ demo: false }, { readOnly: true }, { version: '9.9.9' }]) await assert.rejects(createDemoWriteSession(fakePeer(options).peer, scope));
 await assert.rejects(createDemoWriteSession(fakePeer().peer, { ...scope, environment: 'live' as never }));
});

test('only an exchange business code is a rejection; transport failures and malformed replies are unknown', async () => {
 const caps = { demo: true, readOnly: false, hasAuth: true };
 const cases: Array<[unknown, unknown]> = [
  [{ structuredContent: { tool: 'spot_place_order', ok: true, data: { endpoint: 'POST /api/v5/trade/order', requestTime: '2026-11-02T10:00:00Z', data: [{ ordId: '', clOrdId: 'taeA', sCode: '51008' }] }, capabilities: caps } }, { status: 'rejected', code: '51008' }],
  [{ isError: true, structuredContent: { tool: 'spot_place_order', error: true, type: 'OkxApiError', code: '51008', capabilities: caps } }, { status: 'rejected', code: '51008' }],
  [{ isError: true, structuredContent: { tool: 'spot_place_order', error: true, type: 'NetworkError', code: 'ETIMEDOUT', capabilities: caps } }, { status: 'unknown' }],
  [new Error('transport closed'), { status: 'unknown' }],
  [{ structuredContent: { tool: 'spot_place_order', ok: true, data: { endpoint: 'POST /api/v5/trade/order', requestTime: '2026-11-02T10:00:00Z', data: [{ clOrdId: 'other', sCode: '0', ordId: 'o-2' }] }, capabilities: caps } }, { status: 'unknown' }],
 ];
 for (const [reply, expected] of cases) {
  const writer = await createDemoWriteSession(fakePeer({ reply: (name) => name === 'spot_place_order' ? reply : undefined }).peer, scope);
  assert.deepEqual(await writer.placeEntry(entry), expected);
 }
});
