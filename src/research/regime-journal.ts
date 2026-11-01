import { z } from 'zod';
import { DomainError } from '../lib/errors.ts';
import { canonicalJson, sha256 } from '../lib/hash.ts';
import { newId } from '../lib/ids.ts';
import { allRows, getRow, inTransaction, type Db } from '../store/db.ts';
import { getBundle } from '../store/evidence-store.ts';
import { getRun } from './research-service.ts';

const DAY = 86_400_000;
/** Frozen before the first judgement (user decision 2026-11-01). Any change needs a new version. */
const PROTOCOL = {
 version: 1,
 instruments: [{ site: 'global', instId: 'BTC-USDT', product: 'spot' }, { site: 'global', instId: 'ETH-USDT', product: 'spot' }],
 horizonDays: 7,
 period: 'starts at the next UTC midnight after recordedAt; one judgement per instrument and period',
 labels: ['trend_up', 'trend_down', 'range', 'unclear'],
 scoring: {
  resolution: '1Dutc', closes: 'C0 = close of the UTC day before periodStart, C1..C7 = the daily closes of the period',
  efficiency: '|C7-C0| / sum of |Ci-Ci-1| for i=1..7', trendMinEfficiency: '0.5', rangeMaxEfficiency: '0.3',
  trendDirection: 'trend_up if C7>C0, trend_down if C7<C0', between: 'ambiguous: excluded from the hit rate and counted separately',
  unclear: 'abstention: reported as coverage, never a hit', incompleteData: 'period not scored',
 },
 report: {
  minScoredPerInstrument: 30, overlap: 'periods overlap daily, so scored periods are not independent samples',
  baselines: ['always_range', 'persistence: realized label of the 7 days ending at periodStart', 'base_rate: most frequent realized label over the 365 days before periodStart'],
 },
} as const;
const text = z.string().trim().min(1).max(2000);
const inputSchema = z.strictObject({ instId: z.string(), label: z.enum(['trend_up', 'trend_down', 'range', 'unclear']), reasons: z.array(text).min(1).max(10), bundleId: text, judge: text, runId: text.optional() });
export type RegimeJudgement = z.infer<typeof inputSchema> & { id: string; protocolVersion: number; recordedAt: string; periodStart: string; periodEnd: string; protocolSha256: string; judgeVerified: false; executable: false };

const invalid = (ruleId: string): never => { throw new DomainError('INVALID_INPUT', 'Regime judgement rejected', [{ ruleId }]); };

function migrate(db: Db): void {
 db.exec(`CREATE TABLE IF NOT EXISTS regime_protocols (version INTEGER PRIMARY KEY, content TEXT NOT NULL, content_sha256 TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS regime_protocols_no_update BEFORE UPDATE ON regime_protocols BEGIN SELECT RAISE(ABORT,'regime protocol is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS regime_protocols_no_delete BEFORE DELETE ON regime_protocols BEGIN SELECT RAISE(ABORT,'regime protocol is append-only'); END;
 CREATE TABLE IF NOT EXISTS regime_judgements (id TEXT PRIMARY KEY, protocol_version INTEGER NOT NULL, inst_id TEXT NOT NULL, period_start TEXT NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL, UNIQUE(protocol_version, inst_id, period_start));
 CREATE TRIGGER IF NOT EXISTS regime_judgements_no_update BEFORE UPDATE ON regime_judgements BEGIN SELECT RAISE(ABORT,'regime judgements are append-only'); END;
 CREATE TRIGGER IF NOT EXISTS regime_judgements_no_delete BEFORE DELETE ON regime_judgements BEGIN SELECT RAISE(ABORT,'regime judgements are append-only'); END;`);
}

/** The frozen protocol, or null before the first judgement stored it. */
export function getRegimeProtocol(db: Db) {
 if (!getRow(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='regime_protocols'")) return null;
 const row = getRow<{ content: string; content_sha256: string }>(db, 'SELECT content, content_sha256 FROM regime_protocols WHERE version = ?', PROTOCOL.version);
 if (!row) return null;
 if (sha256(row.content) !== row.content_sha256) throw new DomainError('PERSISTENCE_UNAVAILABLE', 'Regime protocol integrity failure', [{ ruleId: 'regime.protocol_hash' }]);
 return { version: PROTOCOL.version, sha256: row.content_sha256, content: JSON.parse(row.content) as typeof PROTOCOL };
}

/** Stores the protocol on first use; a different stored content under the same version blocks recording. */
function frozenProtocolSha256(db: Db): string {
 const content = canonicalJson(PROTOCOL);
 const row = getRow<{ content: string; content_sha256: string }>(db, 'SELECT content, content_sha256 FROM regime_protocols WHERE version = ?', PROTOCOL.version);
 if (!row) { db.prepare('INSERT INTO regime_protocols VALUES (?,?,?)').run(PROTOCOL.version, content, sha256(content)); return sha256(content); }
 return row.content === content && row.content_sha256 === sha256(content) ? row.content_sha256 : invalid('regime.protocol_conflict');
}

/**
 * Appends one forward-looking regime judgement. The period always starts at the next UTC midnight after the
 * system clock, so a judgement can neither be backdated nor written after its period began. Record only.
 */
export function recordJudgement(db: Db, raw: unknown, now: () => Date): RegimeJudgement {
 const parsed = inputSchema.safeParse(raw); if (!parsed.success) return invalid('regime.schema');
 if (!PROTOCOL.instruments.some(i => i.instId === parsed.data.instId)) return invalid('regime.instrument');
 const at = now().getTime(), start = Math.floor(at / DAY) * DAY + DAY;
 const fields = { ...parsed.data, id: newId('regime'), protocolVersion: PROTOCOL.version, recordedAt: new Date(at).toISOString(), periodStart: new Date(start).toISOString(), periodEnd: new Date(start + 7 * DAY).toISOString(), judgeVerified: false as const, executable: false as const };
 return inTransaction(db, () => {
  migrate(db);
  if (!getBundle(db, parsed.data.bundleId)) return invalid('regime.bundle_exists');
  // A cited multi-agent run must have reached its decision before this judgement.
  if (parsed.data.runId && !getRun(db, parsed.data.runId).decision) return invalid('regime.run_decided');
  const prior = getRow<{ content: string }>(db, 'SELECT content FROM regime_judgements WHERE protocol_version = ? AND inst_id = ? AND period_start = ?', fields.protocolVersion, fields.instId, fields.periodStart);
  if (prior) {
   const old = JSON.parse(prior.content) as RegimeJudgement;
   const { instId, label, reasons, bundleId, judge, runId } = old;
   if (canonicalJson({ instId, label, reasons, bundleId, judge, runId }) !== canonicalJson(parsed.data)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'A different judgement exists for this period', [{ ruleId: 'regime.one_per_period' }]);
   return old;
  }
  const judgement: RegimeJudgement = { ...fields, protocolSha256: frozenProtocolSha256(db) };
  const content = canonicalJson(judgement);
  db.prepare('INSERT INTO regime_judgements VALUES (?,?,?,?,?,?)').run(judgement.id, judgement.protocolVersion, judgement.instId, judgement.periodStart, content, sha256(content));
  return judgement;
 });
}

/** All judgements in period order, plus every instrument-period without one between the first and last period. */
export function listJudgements(db: Db) {
 inTransaction(db, () => migrate(db));
 const rows = allRows<{ content: string; content_sha256: string }>(db, 'SELECT content, content_sha256 FROM regime_judgements ORDER BY period_start, inst_id');
 if (rows.some(r => sha256(r.content) !== r.content_sha256)) throw new DomainError('PERSISTENCE_UNAVAILABLE', 'Regime judgement integrity failure', [{ ruleId: 'regime.judgement_hash' }]);
 const judgements = rows.map(r => JSON.parse(r.content) as RegimeJudgement);
 const missing: Array<{ instId: string; periodStart: string }> = [];
 if (judgements.length) {
  const seen = new Set(judgements.map(j => `${j.instId}@${j.periodStart}`));
  const first = Date.parse(judgements[0]!.periodStart), last = Date.parse(judgements.at(-1)!.periodStart);
  for (const { instId } of PROTOCOL.instruments) for (let t = first; t <= last; t += DAY) {
   const periodStart = new Date(t).toISOString();
   if (!seen.has(`${instId}@${periodStart}`)) missing.push({ instId, periodStart });
  }
 }
 return { judgements, missing };
}
