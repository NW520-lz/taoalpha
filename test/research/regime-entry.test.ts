import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCli, type CliDeps } from '../../src/cli.ts';
import { createResearchMcpServer } from '../../src/mcp/research-server.ts';
import { openDb } from '../../src/store/db.ts';
import { createFakeClient } from '../helpers/fake-okx.ts';
import { marketRoutes, NOW } from '../helpers/market-fixtures.ts';
import { seedBundle } from '../helpers/research-fixtures.ts';

async function deps() {
 const db = openDb(':memory:'); const { bundleId } = await seedBundle(db);
 const value: CliDeps = { db, client: createFakeClient(marketRoutes()).client, now: () => NOW, defaultStrategyPath: 'unused.json' };
 return { deps: value, input: { instId: 'BTC-USDT', label: 'trend_up', reasons: ['synthetic reason'], bundleId, judge: 'synthetic-agent' } };
}

test('the MCP tools record a judgement and list it with the frozen protocol and gaps', async () => {
 const { deps: d, input } = await deps();
 const server = createResearchMcpServer(d), client = new Client({ name: 'synthetic-host', version: '1.0.0' });
 const [a, b] = InMemoryTransport.createLinkedPair();
 try {
  await server.connect(b); await client.connect(a);
  const recorded = await client.callTool({ name: 'taoalpha_regime_record', arguments: input });
  const judgement = (recorded.structuredContent as { value: { periodStart: string; executable: boolean } }).value;
  assert.deepEqual([recorded.isError, judgement.periodStart, judgement.executable], [false, '2026-10-29T00:00:00.000Z', false]);
  const rejected = await client.callTool({ name: 'taoalpha_regime_record', arguments: { ...input, instId: 'SOL-USDT' } });
  assert.deepEqual([rejected.isError, (rejected.structuredContent as { error: { violations: unknown[] } }).error.violations], [true, [{ ruleId: 'regime.instrument' }]]);
  const listed = (await client.callTool({ name: 'taoalpha_regime_list', arguments: {} })).structuredContent as { value: { protocol: { version: number }; judgements: unknown[]; missing: unknown[] } };
  assert.deepEqual([listed.value.protocol.version, listed.value.judgements, listed.value.missing.length], [1, [judgement], 1]);
 } finally { await client.close(); await server.close(); d.db.close(); }
});

test('the CLI records from a file and lists the same judgements', async () => {
 const { deps: d, input } = await deps();
 const dir = mkdtempSync(join(tmpdir(), 'regime-')); const file = join(dir, 'judgement.json');
 try {
  writeFileSync(file, JSON.stringify(input));
  const recorded = await runCli(['research', 'regime-record', '--file', file], d);
  assert.equal(recorded.ok, true);
  const listed = await runCli(['research', 'regime-list'], d);
  assert.deepEqual((listed.value as { judgements: unknown[] }).judgements, [recorded.value]);
  assert.equal((await runCli(['research', 'regime-record'], d)).ok, false);
 } finally { rmSync(dir, { recursive: true, force: true }); d.db.close(); }
});
