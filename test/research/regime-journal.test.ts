import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import type { DomainError } from '../../src/lib/errors.ts';
import { completeTask, nextTasks, startResearch } from '../../src/research/research-service.ts';
import { seedBundle } from '../helpers/research-fixtures.ts';
import { NOW } from '../helpers/market-fixtures.ts';
import { getRegimeProtocol, listJudgements, recordJudgement } from '../../src/research/regime-journal.ts';

const now = () => NOW; // 2026-10-28T12:00Z
const judgement = (bundleId: string, extra = {}) => ({ instId: 'BTC-USDT', label: 'range', reasons: ['synthetic: price oscillated inside a band'], bundleId, judge: 'synthetic-agent', ...extra });

test('a judgement covers the 7 UTC days starting the next day and is stamped by the system clock', async () => {
 const db = openDb(':memory:'); const { bundleId } = await seedBundle(db);
 const stored = recordJudgement(db, judgement(bundleId), now);
 assert.deepEqual([stored.protocolVersion, stored.instId, stored.label, stored.recordedAt, stored.periodStart, stored.periodEnd, stored.executable],
  [1, 'BTC-USDT', 'range', '2026-10-28T12:00:00.000Z', '2026-10-29T00:00:00.000Z', '2026-11-05T00:00:00.000Z', false]);
 assert.deepEqual(listJudgements(db).judgements, [stored]);
 db.close();
});

test('the protocol is frozen with its scoring rule, and instruments outside it are rejected', async () => {
 const db = openDb(':memory:'); const { bundleId } = await seedBundle(db);
 const stored = recordJudgement(db, judgement(bundleId, { instId: 'ETH-USDT' }), now);
 const protocol = getRegimeProtocol(db)!;
 assert.equal(stored.protocolSha256, protocol.sha256);
 assert.deepEqual([protocol.content.instruments.map(i => i.instId), protocol.content.horizonDays, protocol.content.scoring.trendMinEfficiency, protocol.content.scoring.rangeMaxEfficiency],
  [['BTC-USDT', 'ETH-USDT'], 7, '0.5', '0.3']);
 assert.throws(() => recordJudgement(db, judgement(bundleId, { instId: 'SOL-USDT' }), now), /rejected/);
 assert.throws(() => db.prepare('UPDATE regime_protocols SET content = ?').run('{}'));
 assert.throws(() => db.prepare('DELETE FROM regime_protocols').run());
 db.close();
});

test('one judgement per instrument and period: a repeat returns it, a change conflicts, rows are immutable', async () => {
 const db = openDb(':memory:'); const { bundleId } = await seedBundle(db);
 const stored = recordJudgement(db, judgement(bundleId), now);
 const later = () => new Date('2026-10-28T23:59:59.000Z');
 assert.deepEqual(recordJudgement(db, judgement(bundleId), later), stored);
 assert.throws(() => recordJudgement(db, judgement(bundleId, { label: 'trend_up' }), later), (e: DomainError) => e.code === 'IDEMPOTENCY_CONFLICT');
 const nextDay = recordJudgement(db, judgement(bundleId, { label: 'trend_up' }), () => new Date('2026-10-29T00:00:00.000Z'));
 assert.equal(nextDay.periodStart, '2026-10-30T00:00:00.000Z');
 assert.throws(() => db.prepare('UPDATE regime_judgements SET content = ?').run('{}'));
 assert.throws(() => db.prepare('DELETE FROM regime_judgements').run());
 db.close();
});

test('evidence must exist, and a cited research run must already be decided', async () => {
 const db = openDb(':memory:'); const { bundleId } = await seedBundle(db);
 assert.throws(() => recordJudgement(db, judgement('bundle_missing'), now), (e: DomainError) => e.violations[0]?.ruleId === 'regime.bundle_exists');
 const run = startResearch(db, { bundleId, agentMode: 'serial_degraded' }, now);
 assert.throws(() => recordJudgement(db, judgement(bundleId, { runId: run.runId }), now), (e: DomainError) => e.violations[0]?.ruleId === 'regime.run_decided');
 while (nextTasks(db, run.runId).length) for (const t of nextTasks(db, run.runId)) completeTask(db, { assignmentId: t.assignmentId, outcome: { kind: 'failed', reason: 'unavailable' } }, now);
 assert.equal(recordJudgement(db, judgement(bundleId, { runId: run.runId }), now).runId, run.runId);
 db.close();
});

test('missed days are listed as gaps for every protocol instrument', async () => {
 const db = openDb(':memory:'); const { bundleId } = await seedBundle(db);
 assert.deepEqual(listJudgements(db), { judgements: [], missing: [] });
 recordJudgement(db, judgement(bundleId), now);
 recordJudgement(db, judgement(bundleId, { instId: 'ETH-USDT' }), now);
 recordJudgement(db, judgement(bundleId), () => new Date('2026-10-30T08:00:00.000Z'));
 assert.deepEqual(listJudgements(db).missing, [
  { instId: 'BTC-USDT', periodStart: '2026-10-30T00:00:00.000Z' },
  { instId: 'ETH-USDT', periodStart: '2026-10-30T00:00:00.000Z' },
  { instId: 'ETH-USDT', periodStart: '2026-10-31T00:00:00.000Z' },
 ]);
 db.close();
});

test('a protocol stored under the same version with different content blocks new judgements', async () => {
 const db = openDb(':memory:'); const { bundleId } = await seedBundle(db);
 assert.equal(getRegimeProtocol(db), null);
 db.exec("CREATE TABLE regime_protocols (version INTEGER PRIMARY KEY, content TEXT NOT NULL, content_sha256 TEXT NOT NULL); INSERT INTO regime_protocols VALUES (1, '{}', 'x')");
 assert.throws(() => recordJudgement(db, judgement(bundleId), now), /rejected/);
 db.close();
});
