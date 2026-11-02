import { allRows, type Db } from '../store/db.ts';
import { dec } from '../risk/risk-decimal.ts';
import { reconcileDemoAccount } from '../account/demo-reconciliation.ts';
import type { DemoAccountResult } from '../account/demo-account.ts';
import type { DemoReadSnapshot } from '../okx/trade-kit-demo-reader.ts';
import type { StandingGrant } from '../control/standing-authorization.ts';
import type { VetoCardView, VetoDisplayResult } from '../control/veto-display.ts';
import { compileDemoCard } from './trade-card.ts';
import { createVetoWindowService, type TradeCard } from './veto-window.ts';
import { createExecutionIntentService } from './execution-intent.ts';
import { createDemoExecutor, type DemoWriter } from './demo-executor.ts';
import { pipelineSignal, PIPELINE_STRATEGY } from './pipeline-signal.ts';

type Lookup = { status: 'found'; row: Record<string, unknown> } | { status: 'not_found' };
export interface AccountRead { snapshot: DemoReadSnapshot; account: DemoAccountResult; orderByClientId(instId: string, clOrdId: string): Promise<Lookup> }
type Instrument = { instId: string; product: 'spot'; baseCcy: string; quoteCcy: 'USDT'; state: string; listTime: string | null; tickSz: string; lotSz: string; minSz: string; ctVal: null };
export interface Market { candles: Array<{ ts: number; closeTime: number; open: string; high: string; low: string; close: string; confirmed: boolean }>; quote: { priceUsdt: string; at: string; sourceRef: string }; instrument: Instrument }
type ActiveGrant = { proposalId: string; subjectHash: string; scopeId: string; accountRef: string; site: string; confirmedAt: string; grant: StandingGrant };
type RiskPolicy = { version: number; spotBudgetUsdt: string; perpetualBudgetUsdt: string; maxSpotAssets: number; maxPerpetualPositions: number; maxSpotPlanLossUsdt: string; maxPerpetualPlanLossUsdt: string; maxPerpetualLeverage: string };

/** Everything the cycle touches, constructed by the trusted process (demo-run.ts) or by tests. */
export interface CycleDeps {
 db: Db; now: () => Date; sleep: (ms: number) => Promise<void>;
 refreshSession(): Promise<boolean>;
 activeGrant(): ActiveGrant | null;
 riskPolicy(version: number): RiskPolicy | null;
 market(): Promise<Market>;
 readAccount(): Promise<AccountRead>;
 display: { show(card: VetoCardView, onShown: () => void): Promise<VetoDisplayResult> };
 openWriter(): Promise<DemoWriter & { close(): Promise<void> }>;
 log(line: string): void;
}
const INST = 'BTC-USDT';
const COSTS = { feePpm: 1000, slippagePpm: 500, assumptionRef: 'okx-demo-taker-0.10%-plus-0.05%-slippage' };

/** One reconciliation of the account against every intent of the scope, with entry lookups and managed holdings. */
export async function reconcileScope(db: Db, read: AccountRead, active: ActiveGrant, now: number) {
 const intents = createExecutionIntentService(db, () => new Date(now)).list(active.scopeId);
 const hasSubmissions = allRows<{ n: number }>(db, "SELECT count(*) n FROM sqlite_master WHERE name='execution_submissions'")[0]!.n > 0;
 const submitted = new Set(hasSubmissions ? allRows<{ intent_id: string }>(db, "SELECT intent_id FROM execution_submissions WHERE role='entry'").map(r => r.intent_id) : []);
 const open = read.snapshot.parts.spotOrders.status === 'ok' ? read.snapshot.parts.spotOrders.pages.flatMap(p => p.rows) : [];
 const entryLookups: Record<string, Lookup | undefined> = {}, managed: Record<string, string> = {};
 for (const i of intents) {
  if (!submitted.has(i.intentId)) continue;
  const entryId = i.actions.find(a => a.role === 'entry')!.clientOrderId;
  let row = open.find(r => r.clOrdId === entryId);
  if (!row) { const lookup = await read.orderByClientId(i.instId, entryId); entryLookups[i.intentId] = lookup; if (lookup.status === 'found') row = lookup.row; }
  // Held = filled size plus the (negative) fee when it was charged in the base coin.
  if (row) { const held = dec(String(row.accFillSz ?? '0')).plus(row.feeCcy === i.baseCcy ? dec(String(row.fee ?? '0')) : 0); managed[i.baseCcy] = dec(managed[i.baseCcy] ?? '0').plus(held).toFixed(); }
 }
 return reconcileDemoAccount({ snapshot: read.snapshot, account: read.account, intents, now, capital: { sinceMs: Date.parse(active.confirmedAt), recordedBillIds: [] },
  submittedIntentIds: [...submitted], entryLookups, managedHoldings: managed });
}

function view(card: TradeCard, seconds: number): VetoCardView {
 return { title: `${card.instrument.instId} 现货做多（模拟盘，管道验证，非交易策略）`, seconds, lines: [
  `数量：${card.baseQuantity} BTC，参考价 ${card.entry.referencePriceUsdt} USDT`,
  `初始止损：${card.protection.initialStopPriceUsdt}；移动止损回调：${card.protection.trailing.callbackSpreadUsdt}`,
  `计划最大损失（含费用与滑点）：${card.risk.plannedLossUsdt} USDT`,
  `卡片哈希：${card.contentSha256.slice(0, 16)}…  到期：${card.expiresAt}`,
  '点"拒绝执行"或关闭窗口即作废；不操作将在倒计时结束后按常设授权执行。'] };
}

/**
 * One demo pipeline cycle under ADR-012: reconcile, compile a pipeline-check card, show it, let the veto window
 * run, and only if approved consume it, re-check and send the entry, wait for its fill, protect it and reconcile
 * again. Every stop on the way is reported with its reason; nothing is retried or resent.
 */
export async function runDemoCycle(d: CycleDeps) {
 const stop = (stage: string, reasons: string[]) => ({ stage, reasons });
 if (!(await d.refreshSession())) return stop('session', ['cycle.session_unavailable']);
 const active = d.activeGrant(); if (!active) return stop('grant', ['cycle.no_active_grant']);
 const policy = d.riskPolicy(active.grant.riskPolicyVersion); if (!policy) return stop('grant', ['cycle.risk_policy_missing']);
 const intents = createExecutionIntentService(d.db, d.now);
 const veto = createVetoWindowService(d.db, { internalActive: () => d.activeGrant() as never },
  { current: () => ({ openPositions: intents.openPositions(active.scopeId), realizedLossTodayUsdt: '0' }) }, d.now);
 const market = await d.market();
 const signal = pipelineSignal({ instId: INST, candles: market.candles, evidenceRef: market.quote.sourceRef });
 if (!signal) return stop('signal', ['cycle.not_enough_closed_candles']);
 const recon = await reconcileScope(d.db, await d.readAccount(), active, d.now().getTime());
 d.log(`reconcile: ${recon.blockNewRisk ? 'blocked ' + recon.reasons.join(',') : 'ok'}`);
 if (recon.blockNewRisk) return stop('reconcile', recon.reasons);
 const compiled = compileDemoCard({ scope: { scopeId: active.scopeId, accountRef: active.accountRef, site: active.site, environment: 'demo' },
  strategy: { id: PIPELINE_STRATEGY.id, version: PIPELINE_STRATEGY.version, validation: 'unvalidated' }, signal,
  quote: { ...market.quote, maxAgeSeconds: 30 }, instrument: market.instrument, costModel: COSTS, riskPolicy: policy,
  maxPlanLossUsdt: active.grant.limits.maxPlanLossUsdtPerCard,
  portfolio: { accountReconciled: recon.accountReconciled, lossLedgerBlocksNewRisk: false, commitments: intents.openCommitments(active.scopeId, { at: market.quote.at, pricesUsdt: { [INST]: market.quote.priceUsdt } }) },
  validForSeconds: active.grant.vetoWindowSeconds + 900 }, d.now);
 if (!compiled.card) return stop('card', compiled.reasons);
 const card = compiled.card, submitted = veto.submit(card);
 if (submitted.status !== 'awaiting_display') return stop('veto', submitted.reasons);
 d.log(`card ${card.contentSha256.slice(0, 12)}: showing veto window`);
 let shown = false;
 const shownResult = await d.display.show(view(card, active.grant.vetoWindowSeconds), () => { veto.markDisplayed(card.contentSha256); shown = true; });
 if (!shown) return stop('display', ['cycle.display_unavailable']);
 // A rejection, a closed window or a display that broke after showing all void the card.
 if (shownResult !== 'elapsed') { veto.reject(card.contentSha256); return stop('veto', [shownResult === 'rejected' ? 'cycle.user_rejected' : 'cycle.display_failed']); }
 let settled = veto.settle(card.contentSha256);
 for (let i = 0; settled.status === 'in_window' && i < 120; i++) { await d.sleep(1000); settled = veto.settle(card.contentSha256); }
 if (settled.status !== 'approved') return stop('veto', [`cycle.${settled.status}`, ...settled.reasons]);
 const intent = intents.consume(card.contentSha256);
 const fresh = await reconcileScope(d.db, await d.readAccount(), active, d.now().getTime());
 const quote = (await d.market()).quote;
 const writer = await d.openWriter();
 try {
  const executor = createDemoExecutor(d.db, writer, d.now);
  const entry = await executor.submitEntry(intent.intentId, { reconciliation: fresh, quote, maxQuoteAgeSeconds: 30, maxPriceDeviationPpm: 10_000 });
  d.log(`entry: ${entry.status} ${entry.reasons.join(',')}`);
  if (entry.status !== 'accepted') return { stage: 'entry', reasons: entry.reasons.length ? entry.reasons : [`cycle.entry_${entry.status}`], intentId: intent.intentId };
  // Wait for the market order's fill by its client order id; never resend.
  let fill: Record<string, unknown> | null = null;
  for (let i = 0; i < 20 && !fill; i++) {
   const lookup = await (await d.readAccount()).orderByClientId(INST, intent.actions[0]!.clientOrderId);
   if (lookup.status === 'found' && lookup.row.state === 'filled') fill = lookup.row; else await d.sleep(1500);
  }
  if (!fill) return { stage: 'fill', reasons: ['cycle.fill_not_confirmed'], intentId: intent.intentId };
  const protection = await executor.placeProtection(intent.intentId, { accFillSz: String(fill.accFillSz), fee: String(fill.fee ?? '0'), feeCcy: String(fill.feeCcy ?? ''), lotSz: market.instrument.lotSz });
  d.log(`protection: ${protection.map(p => `${p.role}=${p.status}`).join(' ')}`);
  const after = await reconcileScope(d.db, await d.readAccount(), active, d.now().getTime());
  return { stage: 'done', reasons: after.reasons, intentId: intent.intentId, protection: protection.map(p => ({ role: p.role, status: p.status })), reconciled: after.accountReconciled };
 } finally { await writer.close(); }
}
