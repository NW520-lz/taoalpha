import { canonicalJson, sha256 } from '../lib/hash.ts';
import { DomainError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { allRows, getRow, inTransaction, type Db } from '../store/db.ts';
import { dec } from '../risk/risk-decimal.ts';
import type { RiskCommitment } from '../risk/entry-risk.ts';
import type { TradeCard } from './veto-window.ts';

const ROLES = [['entry', 'e'], ['initial_stop', 's'], ['trailing_stop', 't']] as const;
const TABLES = ['execution_intents', 'execution_intent_actions', 'execution_exits'];
const DDL = [
 `CREATE TABLE IF NOT EXISTS execution_intents(intent_id TEXT PRIMARY KEY,card_hash TEXT UNIQUE NOT NULL,scope_id TEXT NOT NULL,content_json TEXT NOT NULL,created_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS execution_exits(intent_id TEXT PRIMARY KEY REFERENCES execution_intents(intent_id),detected_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS execution_intent_actions(client_order_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES execution_intents(intent_id),role TEXT NOT NULL,UNIQUE(intent_id,role))`,
 ...TABLES.flatMap(t => [`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`, `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`]),
];
function fail(ruleId: string): never { throw new DomainError('INVALID_INPUT', 'Execution intent rejected', [{ ruleId }]); }
// OKX client order ids: up to 32 alphanumerics. Derived from the card and role, so a retry reuses the same id.
const clientOrderId = (cardHash: string, role: string, code: string) => `ta${code}${sha256(`${cardHash}:${role}`).slice(0, 28)}`;

type Intent = { intentId: string; cardHash: string; scopeId: string; accountRef: string; environment: string; instId: string; product: string; direction: string;
 baseCcy: string; baseQuantity: string; budgetUsdt: string; plannedLossUsdt: string; costsUsdt: string; createdAt: string; actions: Array<{ role: string; clientOrderId: string }> };

/**
 * I-06/I-07: an approved card becomes exactly one persisted intent, with its budget reserved and every child
 * action's client order id fixed, before anything is sent to the exchange. Retries and other connections
 * get the same intent. The intent keeps its reservation until exchange reconciliation releases it.
 */
export function createExecutionIntentService(db: Db, now: () => Date) {
 inTransaction(db, () => { for (const sql of DDL) db.exec(sql); });
 const view = (row: { content_json: string }) => ({ ...(JSON.parse(row.content_json) as Intent), state: 'reserved' as const });
 // No release path exists yet: until exchange reconciliation proves an intent final, every intent stays open (I-09).
 // An intent is known final, and so released, only when its card expired and none of its orders was ever sent.
 const open = (scopeId: string) => {
  const sentTable = !!getRow(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_submissions'");
  const rows = allRows<{ content_json: string; expires_at: string; sent: number }>(db, `SELECT i.content_json, json_extract(c.card_json,'$.expiresAt') expires_at,
   ${sentTable ? '(SELECT count(*) FROM execution_submissions s WHERE s.intent_id=i.intent_id)' : '0'} sent
   FROM execution_intents i JOIN veto_cards c ON c.card_hash=i.card_hash WHERE i.scope_id=? AND i.intent_id NOT IN (SELECT intent_id FROM execution_exits) ORDER BY i.rowid`, scopeId);
  const at = now().getTime();
  return rows.filter(r => r.sent > 0 || Date.parse(r.expires_at) > at).map(view);
 };
 return {
  /** Unreleased intents as entry-risk commitments, valued at one instant; a missing price blocks instead of counting as zero. */
  openCommitments(scopeId: string, valuation: { at: string; pricesUsdt: Record<string, string> }): RiskCommitment[] {
   return open(scopeId).map(i => {
    const price = valuation.pricesUsdt[i.instId];
    if (price === undefined) fail('intent.valuation_missing');
    return { instId: i.instId, baseCcy: i.baseCcy, product: i.product as RiskCommitment['product'], direction: i.direction as RiskCommitment['direction'], sourceRef: i.intentId, valuedAt: valuation.at,
     stage: 'pending' as const, budgetUsdt: i.budgetUsdt, notionalUsdt: dec(i.baseQuantity).times(price).toFixed(), plannedLossUsdt: i.plannedLossUsdt, costsUsdt: i.costsUsdt };
   });
  },
  openPositions(scopeId: string) { return open(scopeId).length; },
  /** A stop triggered and no protective order of the intent is left at the exchange: the intent is final and released. */
  markExited(intentId: string) { inTransaction(db, () => { if (!getRow(db, 'SELECT 1 FROM execution_exits WHERE intent_id=?', intentId)) db.prepare('INSERT INTO execution_exits VALUES(?,?)').run(intentId, now().toISOString()); }); },
  /** Every intent of the scope in creation order, for reconciliation. */
  list(scopeId: string) { return open(scopeId); },
  consume(cardHash: string) {
   return inTransaction(db, () => {
    const existing = getRow<{ content_json: string }>(db, 'SELECT content_json FROM execution_intents WHERE card_hash=?', cardHash);
    if (existing) return view(existing);
    // Only a recorded approval can be consumed; the UNIQUE card_hash makes the consumption single.
    const hasApprovals = !!getRow(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='veto_approvals'");
    const stored = hasApprovals ? getRow<{ card_json: string }>(db, 'SELECT c.card_json FROM veto_approvals a JOIN veto_cards c ON c.card_hash=a.card_hash WHERE a.card_hash=?', cardHash) : undefined;
    if (!stored) fail('intent.not_approved');
    const card = JSON.parse(stored.card_json) as TradeCard;
    const intent: Intent = { intentId: newId('intent'), cardHash, scopeId: card.scope.scopeId, accountRef: card.scope.accountRef, environment: card.environment,
     instId: card.instrument.instId, product: card.instrument.product, direction: card.direction, baseCcy: card.instrument.instId.split('-')[0]!, baseQuantity: card.baseQuantity,
     budgetUsdt: card.risk.budgetRequiredUsdt, plannedLossUsdt: card.risk.plannedLossUsdt, costsUsdt: dec(card.risk.feesUsdt).plus(card.risk.slippageUsdt).toFixed(), createdAt: now().toISOString(),
     actions: ROLES.map(([role, code]) => ({ role, clientOrderId: clientOrderId(cardHash, role, code) })) };
    db.prepare('INSERT INTO execution_intents VALUES(?,?,?,?,?)').run(intent.intentId, cardHash, intent.scopeId, canonicalJson(intent), intent.createdAt);
    for (const a of intent.actions) db.prepare('INSERT INTO execution_intent_actions VALUES(?,?,?)').run(a.clientOrderId, intent.intentId, a.role);
    return view({ content_json: canonicalJson(intent) });
   });
  },
 };
}
