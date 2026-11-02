import { DomainError } from '../lib/errors.ts';
import { getRow, inTransaction, type Db } from '../store/db.ts';
import { dec } from '../risk/risk-decimal.ts';
import type { TradeCard } from './veto-window.ts';

/** What the exchange said about one order. `unknown` (timeout, broken transport) must never be resent. */
export type WriteOutcome = { status: 'accepted'; exchangeId: string } | { status: 'rejected'; code: string } | { status: 'unknown' };
/** Port to the demo-only write connection; arguments are the exchange's own field names. */
export interface DemoWriter {
 placeEntry(args: Record<string, string>): Promise<WriteOutcome>;
 placeAlgo(args: Record<string, string>): Promise<WriteOutcome>;
}
type Intent = { intentId: string; cardHash: string; instId: string; baseQuantity: string; actions: Array<{ role: string; clientOrderId: string }> };
type Recorded = { status: 'sending' | 'accepted' | 'rejected' | 'unknown'; exchangeId: string | null; code: string | null };

const TABLES = ['execution_submissions', 'execution_outcomes'];
const DDL = [
 `CREATE TABLE IF NOT EXISTS execution_submissions(client_order_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL,role TEXT NOT NULL,args_json TEXT NOT NULL,sent_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS execution_outcomes(client_order_id TEXT PRIMARY KEY REFERENCES execution_submissions(client_order_id),status TEXT NOT NULL,exchange_id TEXT,code TEXT,recorded_at TEXT NOT NULL)`,
 ...TABLES.flatMap(t => [`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`, `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`]),
];
function fail(ruleId: string): never { throw new DomainError('INVALID_INPUT', 'Demo execution rejected', [{ ruleId }]); }

/**
 * Demo executor for one intent (I-04, I-07, I-08). Before any write it re-checks the account, quote and card, then
 * records the submission; only afterwards does it call the exchange, and it records whatever came back. A client
 * order id that was ever sent is never sent again: without a recorded outcome it stays unknown for reconciliation.
 */
export function createDemoExecutor(db: Db, writer: DemoWriter, now: () => Date) {
 inTransaction(db, () => { for (const sql of DDL) db.exec(sql); });
 function load(intentId: string) {
  const row = getRow<{ content_json: string; card_json: string }>(db, 'SELECT i.content_json, c.card_json FROM execution_intents i JOIN veto_cards c ON c.card_hash=i.card_hash WHERE i.intent_id=?', intentId);
  if (!row) fail('execution.unknown_intent');
  return { intent: JSON.parse(row.content_json) as Intent, card: JSON.parse(row.card_json) as TradeCard };
 }
 function recorded(clientOrderId: string): Recorded | null {
  if (!getRow(db, 'SELECT 1 FROM execution_submissions WHERE client_order_id=?', clientOrderId)) return null;
  const outcome = getRow<{ status: Recorded['status']; exchange_id: string | null; code: string | null }>(db, 'SELECT status,exchange_id,code FROM execution_outcomes WHERE client_order_id=?', clientOrderId);
  // Sent without a recorded answer (crash or timeout before recording): unknown until reconciled.
  return outcome ? { status: outcome.status, exchangeId: outcome.exchange_id, code: outcome.code } : { status: 'unknown', exchangeId: null, code: null };
 }
 const view = (r: Recorded) => ({ status: r.status, exchangeId: r.exchangeId, code: r.code, reasons: [] as string[] });
 /** Records the submission, sends it once, records the answer. */
 async function sendOnce(intentId: string, role: string, clientOrderId: string, args: Record<string, string>, send: (a: Record<string, string>) => Promise<WriteOutcome>) {
  const claimed = inTransaction(db, () => {
   if (getRow(db, 'SELECT 1 FROM execution_submissions WHERE client_order_id=?', clientOrderId)) return false;
   db.prepare('INSERT INTO execution_submissions VALUES(?,?,?,?,?)').run(clientOrderId, intentId, role, JSON.stringify(args), now().toISOString());
   return true;
  });
  if (!claimed) return recorded(clientOrderId)!;
  let outcome: WriteOutcome;
  try { outcome = await send(args); } catch { outcome = { status: 'unknown' }; }
  const exchangeId = outcome.status === 'accepted' ? outcome.exchangeId : null, code = outcome.status === 'rejected' ? outcome.code : null;
  inTransaction(db, () => db.prepare('INSERT INTO execution_outcomes VALUES(?,?,?,?,?)').run(clientOrderId, outcome.status, exchangeId, code, now().toISOString()));
  return { status: outcome.status, exchangeId, code };
 }
 return {
  async submitEntry(intentId: string, checks: { reconciliation: { blockNewRisk: boolean }; quote: { priceUsdt: string; at: string }; maxQuoteAgeSeconds: number; maxPriceDeviationPpm: number }) {
   const { intent, card } = load(intentId);
   const entryId = intent.actions.find(a => a.role === 'entry')!.clientOrderId;
   const prior = recorded(entryId); if (prior) return view(prior);
   // I-04 pre-submit recheck: the approval is not a reason to trade on a stale picture.
   const at = now().getTime(), blocked = (reason: string) => ({ status: 'blocked' as const, exchangeId: null, code: null, reasons: [reason] });
   if (at >= Date.parse(card.expiresAt)) return blocked('execution.card_expired');
   if (checks.reconciliation.blockNewRisk) return blocked('execution.account_blocked');
   const age = at - Date.parse(checks.quote.at);
   if (age < 0 || age > checks.maxQuoteAgeSeconds * 1000) return blocked('execution.quote_stale');
   const reference = dec(card.entry.referencePriceUsdt);
   if (dec(checks.quote.priceUsdt).minus(reference).abs().div(reference).times(1_000_000).gt(checks.maxPriceDeviationPpm)) return blocked('execution.price_moved');
   const args = { instId: intent.instId, tdMode: 'cash', side: 'buy', ordType: 'market', sz: intent.baseQuantity, tgtCcy: 'base_ccy', clOrdId: entryId };
   return view(await sendOnce(intentId, 'entry', entryId, args, writer.placeEntry));
  },
  /** After the entry filled: the initial stop and the frozen trailing stop on the base quantity actually held. */
  async placeProtection(intentId: string, fill: { accFillSz: string; fee: string; feeCcy: string; lotSz: string }) {
   const { intent, card } = load(intentId);
   const entry = recorded(intent.actions.find(a => a.role === 'entry')!.clientOrderId);
   if (entry?.status !== 'accepted') fail('execution.entry_not_accepted');
   // A buy's fee is charged in the base coin (negative), so less than the filled size is held.
   const held = dec(fill.accFillSz).plus(fill.feeCcy === card.instrument.instId.split('-')[0] ? dec(fill.fee) : 0);
   const sz = held.divToInt(fill.lotSz).times(fill.lotSz).toFixed();
   const id = (role: string) => intent.actions.find(a => a.role === role)!.clientOrderId;
   const stop = { instId: intent.instId, tdMode: 'cash', side: 'sell', ordType: 'conditional', sz, slTriggerPx: card.protection.initialStopPriceUsdt, slOrdPx: '-1', algoClOrdId: id('initial_stop') };
   const trailing = { instId: intent.instId, tdMode: 'cash', side: 'sell', ordType: 'move_order_stop', sz, callbackSpread: card.protection.trailing.callbackSpreadUsdt, algoClOrdId: id('trailing_stop') };
   const results = [];
   for (const [role, args] of [['initial_stop', stop], ['trailing_stop', trailing]] as const) results.push({ role, ...(await sendOnce(intentId, role, args.algoClOrdId, args, writer.placeAlgo)) });
   return results;
  },
 };
}
