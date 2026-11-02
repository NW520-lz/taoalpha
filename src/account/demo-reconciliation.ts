import { dec } from '../risk/risk-decimal.ts';
import type { DemoReadSnapshot } from '../okx/trade-kit-demo-reader.ts';
import type { DemoAccountResult } from './demo-account.ts';

type IntentRef = { intentId: string; instId: string; actions: Array<{ role: string; clientOrderId: string }> };
type Row = Record<string, unknown>;
const ORDER_PARTS = ['spotOrders', 'perpetualOrders'] as const, ALGO_PARTS = ['spotProtection', 'perpetualProtection'] as const;
/** OKX account bills only reach back this far, so a longer gap since the last full reconciliation cannot be proven. */
const BILL_WINDOW_MS = 7 * 86_400_000;
type Lookup = { status: 'found'; row: Row } | { status: 'not_found' };

/**
 * Compares one demo account read with the local execution intents. Open orders and algo orders belong to an
 * intent only through its client order ids; anything else, any perpetual position (this scope trades spot only),
 * an incomplete read, or an entry with fills but no live initial stop blocks new risk (I-17, I-19). Pure.
 */
export function reconcileDemoAccount(input: { snapshot: DemoReadSnapshot; account: DemoAccountResult; intents: IntentRef[]; now: number;
 capital: { sinceMs: number; recordedBillIds: string[] }; submittedIntentIds: string[]; entryLookups: Record<string, Lookup | undefined>;
 /** Base coin each currency's intents hold by their own fills net of base-coin fees; holdings beyond it are unmanaged. */
 managedHoldings: Record<string, string> }) {
 const { snapshot, account, intents, capital } = input;
 const reasons = new Set<string>();
 const complete = snapshot.accountReadComplete && account.ok && account.readsComplete && Object.values(snapshot.parts).every(p => p.status === 'ok');
 if (!complete) return { blockNewRisk: true as const, accountReconciled: false, reasons: ['reconcile.read_incomplete'], unmanagedOrders: null, intents: [], gaps: [] as string[] };
 const rows = (parts: readonly (keyof DemoReadSnapshot['parts'])[]) => parts.flatMap(p => { const part = snapshot.parts[p]; return part.status === 'ok' ? part.pages.flatMap(page => page.rows) : []; });
 const orders = rows(ORDER_PARTS), algos = rows(ALGO_PARTS);
 const ownIds = new Set(intents.flatMap(i => i.actions.map(a => a.clientOrderId)));
 const idOf = (row: Row, key: 'clOrdId' | 'algoClOrdId') => typeof row[key] === 'string' ? row[key] as string : '';
 const unmanaged = orders.filter(r => !ownIds.has(idOf(r, 'clOrdId'))).length + algos.filter(r => !ownIds.has(idOf(r, 'algoClOrdId'))).length;
 if (unmanaged) reasons.add('reconcile.unmanaged_order');
 if (account.ok && account.account.positions.some(p => !dec(p.contracts).isZero())) reasons.add('reconcile.unmanaged_position');
 // Spot ownership: the coins our intents bought must still be there; extra coins are never ours to sell.
 const coins = account.ok ? account.account.equity.assets : [];
 for (const [ccy, qty] of Object.entries(input.managedHoldings)) if (dec(coins.find(a => a.currency === ccy)?.equity.amount ?? '0').lt(qty)) reasons.add('reconcile.managed_holding_missing');
 // Capital history: every transfer (bill type 1) since the last full reconciliation must already be in the local ledger.
 if (input.now - capital.sinceMs > BILL_WINDOW_MS) reasons.add('reconcile.capital_window_exceeded');
 const recorded = new Set(capital.recordedBillIds);
 if (rows(['bills']).some(b => b.type === '1' && Number(b.ts) >= capital.sinceMs && !recorded.has(String(b.billId)))) reasons.add('reconcile.capital_event_unrecorded');
 const stateOf = (list: Row[], key: 'clOrdId' | 'algoClOrdId', id: string | undefined) => { const row = list.find(r => idOf(r, key) === id); return row ? String(row.state) : 'not_open'; };
 const report = intents.map(i => {
  const id = (role: string) => i.actions.find(a => a.role === role)?.clientOrderId;
  const open = orders.find(r => idOf(r, 'clOrdId') === id('entry'));
  // A submitted entry that left the open list (filled or cancelled) is looked up by its client order id.
  let entryRow: Row | undefined = open;
  if (!open && input.submittedIntentIds.includes(i.intentId)) {
   const lookup = input.entryLookups[i.intentId];
   if (!lookup) reasons.add('reconcile.entry_lookup_missing');
   else if (lookup.status === 'not_found') reasons.add('reconcile.submitted_entry_unknown');
   else entryRow = lookup.row;
  }
  const initialStop = stateOf(algos, 'algoClOrdId', id('initial_stop'));
  if (entryRow && dec(String(entryRow.accFillSz ?? '0')).gt(0) && initialStop !== 'live') reasons.add('reconcile.protection_missing');
  return { intentId: i.intentId, entry: entryRow ? String(entryRow.state) : 'not_open', initialStop, trailingStop: stateOf(algos, 'algoClOrdId', id('trailing_stop')) };
 });
 const blockNewRisk = reasons.size > 0;
 return { blockNewRisk, accountReconciled: !blockNewRisk, reasons: [...reasons], unmanagedOrders: unmanaged, intents: report, gaps: [] as string[] };
}
