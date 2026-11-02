import { z } from 'zod';
import { DomainError } from '../lib/errors.ts';
import { TRADE_KIT_VERSION, type DemoScope, type TradeKitPeer } from './trade-kit-demo-reader.ts';
import type { DemoWriter, WriteOutcome } from '../trade/demo-executor.ts';

const TOOLS = {
 entry: { tool: 'spot_place_order', endpoint: 'POST /api/v5/trade/order', id: 'ordId', clientId: 'clOrdId' },
 algo: { tool: 'spot_place_algo_order', endpoint: 'POST /api/v5/trade/order-algo', id: 'algoId', clientId: 'algoClOrdId' },
 cancel: { tool: 'spot_cancel_order', endpoint: 'POST /api/v5/trade/cancel-order', id: 'ordId', clientId: 'clOrdId' },
} as const;
const capabilities = z.object({ demo: z.literal(true), readOnly: z.literal(false), hasAuth: z.literal(true) });
const success = z.object({ structuredContent: z.object({ tool: z.string(), ok: z.literal(true), capabilities,
 data: z.object({ endpoint: z.string(), data: z.array(z.record(z.string(), z.unknown())).length(1) }) }) });
const businessError = z.object({ isError: z.literal(true), structuredContent: z.object({ tool: z.string(), type: z.literal('OkxApiError'), code: z.string().regex(/^\d+$/) }) });

function unavailable(ruleId: string): never { throw new DomainError('DEPENDENCY_UNAVAILABLE', 'Trade Kit demo writer is unavailable', [{ ruleId }]); }

/**
 * Demo-only order writer. It refuses any server that is not the pinned Trade Kit running in demo with write
 * capability. Only an OKX business code counts as a rejection; transport failures and replies that do not match
 * the request are `unknown`, which callers must reconcile instead of resending (I-07).
 */
export async function createDemoWriteSession(peer: TradeKitPeer, scope: DemoScope): Promise<DemoWriter> {
 if (scope.environment !== 'demo' || !['global', 'eea', 'us', 'tr'].includes(scope.site)) unavailable('tradekit.demo_scope');
 const server = peer.getServerVersion();
 if (server?.name !== 'okx-trade-mcp' || server.version !== TRADE_KIT_VERSION) unavailable('tradekit.version_pinned');
 const listed = z.object({ tools: z.array(z.object({ name: z.string() })) }).safeParse(await peer.listTools().catch(() => null));
 const names = new Set(listed.success ? listed.data.tools.map(t => t.name) : []);
 if (!['system_get_capabilities', TOOLS.entry.tool, TOOLS.algo.tool, TOOLS.cancel.tool].every(n => names.has(n))) unavailable('tradekit.required_writes');
 const system = z.object({ structuredContent: z.object({ ok: z.literal(true), data: z.object({ server: z.object({ name: z.literal('okx-trade-mcp'), version: z.literal(TRADE_KIT_VERSION) }), capabilities }) }) })
  .safeParse(await peer.callTool({ name: 'system_get_capabilities', arguments: {} }).catch(() => null));
 if (!system.success) unavailable('tradekit.demo_write_capabilities');

 async function place(spec: typeof TOOLS[keyof typeof TOOLS], args: Record<string, string>): Promise<WriteOutcome> {
  let raw: unknown;
  try { raw = await peer.callTool({ name: spec.tool, arguments: args }); } catch { return { status: 'unknown' }; }
  const rejected = businessError.safeParse(raw);
  if (rejected.success && rejected.data.structuredContent.tool === spec.tool) return { status: 'rejected', code: rejected.data.structuredContent.code };
  const ok = success.safeParse(raw);
  if (!ok.success || ok.data.structuredContent.tool !== spec.tool || ok.data.structuredContent.data.endpoint !== spec.endpoint) return { status: 'unknown' };
  const row = ok.data.structuredContent.data.data[0]!;
  // The reply must be about the order we sent; anything else cannot prove what happened.
  if (row[spec.clientId] !== args[spec.clientId] || typeof row.sCode !== 'string') return { status: 'unknown' };
  if (row.sCode !== '0') return /^\d+$/.test(row.sCode) ? { status: 'rejected', code: row.sCode } : { status: 'unknown' };
  return typeof row[spec.id] === 'string' && row[spec.id] ? { status: 'accepted', exchangeId: row[spec.id] as string } : { status: 'unknown' };
 }
 return { placeEntry: (args) => place(TOOLS.entry, args), placeAlgo: (args) => place(TOOLS.algo, args), cancelOrder: (args) => place(TOOLS.cancel, args) };
}
