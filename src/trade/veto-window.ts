import { canonicalJson, hashJson } from '../lib/hash.ts';
import { dec } from '../risk/risk-decimal.ts';
import { DomainError } from '../lib/errors.ts';
import { allRows, getRow, inTransaction, type Db } from '../store/db.ts';
import type { StandingGrant } from '../control/standing-authorization.ts';
import type { compileDemoCard } from './trade-card.ts';

export type TradeCard = NonNullable<ReturnType<typeof compileDemoCard>['card']>;
type ActiveGrant = { proposalId: string; subjectHash: string; scopeId: string; accountRef: string; site: string; grant: StandingGrant };
/** Ports: the active standing grant (ADR-012) and the account's current exposure, both owned by other modules. */
export interface GrantSource { internalActive(): ActiveGrant | null }
export interface ExposureSource { current(): { openPositions: number; realizedLossTodayUsdt: string } }

const TABLES = ['veto_cards', 'veto_displays', 'veto_rejections', 'veto_voids', 'veto_approvals'];
const DDL = [
 `CREATE TABLE IF NOT EXISTS veto_cards(card_hash TEXT PRIMARY KEY,card_json TEXT NOT NULL,grant_proposal_id TEXT NOT NULL,grant_subject_hash TEXT NOT NULL,submitted_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS veto_displays(card_hash TEXT PRIMARY KEY REFERENCES veto_cards(card_hash),displayed_at TEXT NOT NULL,window_ends_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS veto_rejections(card_hash TEXT PRIMARY KEY REFERENCES veto_cards(card_hash),rejected_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS veto_voids(card_hash TEXT PRIMARY KEY REFERENCES veto_cards(card_hash),reasons_json TEXT NOT NULL,voided_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS veto_approvals(card_hash TEXT PRIMARY KEY REFERENCES veto_cards(card_hash),approval_json TEXT NOT NULL)`,
 ...TABLES.flatMap(t => [`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`, `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`]),
];
function fail(ruleId: string): never { throw new DomainError('INVALID_INPUT', 'Veto window operation rejected', [{ ruleId }]); }

/**
 * ADR-012 veto windows. A card inside the active grant starts its window only once the local entry reports it
 * displayed; when the window ends without a rejection, the backend records the approval from persisted facts.
 */
export function createVetoWindowService(db: Db, grants: GrantSource, exposure: ExposureSource, now: () => Date) {
 inTransaction(db, () => { for (const sql of DDL) db.exec(sql); });
 const iso = () => now().toISOString();
 const display = (hash: string) => getRow<{ displayed_at: string; window_ends_at: string }>(db, 'SELECT displayed_at,window_ends_at FROM veto_displays WHERE card_hash=?', hash);
 const stored = (hash: string) => { const row = getRow<{ card_json: string; grant_proposal_id: string; grant_subject_hash: string }>(db, 'SELECT card_json,grant_proposal_id,grant_subject_hash FROM veto_cards WHERE card_hash=?', hash); if (!row) fail('veto.unknown_card'); return row; };
 const rejected = (hash: string) => !!getRow(db, 'SELECT 1 FROM veto_rejections WHERE card_hash=?', hash);
 const utcDay = (at: Date) => at.toISOString().slice(0, 10);
 /** Every reason the card falls outside the grant right now (ADR-012 point 4); empty means inside. */
 function outsideGrant(card: TradeCard, active: ActiveGrant | null, excludeHash?: string): string[] {
  if (!active) return ['veto.no_active_grant'];
  const g = active.grant, reasons: string[] = [], at = now(), live = exposure.current();
  if (card.scope.scopeId !== active.scopeId || card.scope.accountRef !== active.accountRef || card.scope.site !== active.site || card.environment !== g.environment) reasons.push('veto.account_scope');
  if (card.strategy.id !== g.strategy.id || card.strategy.version !== g.strategy.version) reasons.push('veto.strategy');
  if (!g.instruments.some(i => i.instId === card.instrument.instId && i.product === card.instrument.product)) reasons.push('veto.instrument');
  if (card.risk.riskPolicyVersion !== g.riskPolicyVersion) reasons.push('veto.risk_policy_version');
  if (dec(card.risk.plannedLossUsdt).gt(g.limits.maxPlanLossUsdtPerCard)) reasons.push('veto.plan_loss');
  if (at.getTime() >= Date.parse(card.expiresAt)) reasons.push('veto.card_expired');
  if (live.openPositions >= g.limits.maxOpenPositions) reasons.push('veto.open_positions');
  if (dec(live.realizedLossTodayUsdt).gte(g.limits.dailyLossLimitUsdt)) reasons.push('veto.daily_loss_limit');
  // Cards of this grant submitted on the same UTC day and not rejected use up the daily quota.
  const today = allRows<{ card_hash: string }>(db, 'SELECT card_hash FROM veto_cards WHERE grant_proposal_id=? AND substr(submitted_at,1,10)=? AND card_hash NOT IN (SELECT card_hash FROM veto_rejections)', active.proposalId, utcDay(at))
   .filter(r => r.card_hash !== excludeHash);
  if (today.length >= g.limits.maxCardsPerDay) reasons.push('veto.daily_card_limit');
  return reasons;
 }
 // The hash covers the card body; any edit after compilation is a different, unreviewed card.
 function checkIntegrity(card: TradeCard) {
  const { contentSha256, executable, ...body } = card;
  if (executable !== false || hashJson(body) !== contentSha256) fail('veto.card_integrity');
 }
 return {
  submit(card: TradeCard) {
   return inTransaction(db, () => {
    checkIntegrity(card);
    if (getRow(db, 'SELECT 1 FROM veto_cards WHERE card_hash=?', card.contentSha256)) return { cardHash: card.contentSha256, status: 'awaiting_display' as const, reasons: [] as string[] };
    const active = grants.internalActive(), reasons = outsideGrant(card, active);
    if (reasons.length || !active) return { cardHash: card.contentSha256, status: 'out_of_scope' as const, reasons };
    db.prepare('INSERT INTO veto_cards VALUES(?,?,?,?,?)').run(card.contentSha256, canonicalJson(card), active.proposalId, active.subjectHash, iso());
    return { cardHash: card.contentSha256, status: 'awaiting_display' as const, reasons: [] as string[] };
   });
  },
  /** Called only by the local display adapter after the card was actually shown. */
  markDisplayed(cardHash: string) {
   return inTransaction(db, () => {
    stored(cardHash);
    if (rejected(cardHash)) fail('veto.rejected');
    const prior = display(cardHash); if (prior) return { cardHash, windowEndsAt: prior.window_ends_at };
    // No window starts without the grant the card was accepted under.
    const active = grants.internalActive();
    if (!active) fail('veto.no_active_grant');
    if (active.proposalId !== stored(cardHash).grant_proposal_id) fail('veto.grant_changed');
    const at = now(), ends = new Date(at.getTime() + active.grant.vetoWindowSeconds * 1000).toISOString();
    db.prepare('INSERT INTO veto_displays VALUES(?,?,?)').run(cardHash, at.toISOString(), ends);
    return { cardHash, windowEndsAt: ends };
   });
  },
  /** Rejecting only lowers risk: any local entry may do it until the window ends. */
  reject(cardHash: string) {
   return inTransaction(db, () => {
    stored(cardHash);
    if (!rejected(cardHash)) {
     const shown = display(cardHash);
     if (getRow(db, 'SELECT 1 FROM veto_approvals WHERE card_hash=?', cardHash) || (shown && now().getTime() >= Date.parse(shown.window_ends_at))) fail('veto.window_closed');
     db.prepare('INSERT INTO veto_rejections VALUES(?,?)').run(cardHash, iso());
    }
    return { cardHash, status: 'rejected' as const };
   });
  },
  /** Cards still waiting for display or inside their window, oldest first, with seconds left when shown. */
  pending() {
   const rows = allRows<{ card_hash: string; window_ends_at: string | null }>(db, `SELECT c.card_hash, d.window_ends_at FROM veto_cards c LEFT JOIN veto_displays d ON d.card_hash=c.card_hash
    WHERE c.card_hash NOT IN (SELECT card_hash FROM veto_rejections) AND c.card_hash NOT IN (SELECT card_hash FROM veto_voids) AND c.card_hash NOT IN (SELECT card_hash FROM veto_approvals)
    ORDER BY c.submitted_at, c.card_hash`);
   const at = now().getTime();
   type Pending = { cardHash: string; status: 'awaiting_display' | 'in_window'; secondsLeft: number | null };
   return rows.flatMap((r): Pending[] => r.window_ends_at === null ? [{ cardHash: r.card_hash, status: 'awaiting_display' as const, secondsLeft: null }]
    : Date.parse(r.window_ends_at) > at ? [{ cardHash: r.card_hash, status: 'in_window' as const, secondsLeft: Math.ceil((Date.parse(r.window_ends_at) - at) / 1000) }] : []);
  },
  settle(cardHash: string) {
   return inTransaction(db, () => {
    const card = stored(cardHash);
    const approved = getRow<{ approval_json: string }>(db, 'SELECT approval_json FROM veto_approvals WHERE card_hash=?', cardHash);
    const none: string[] = [];
    if (approved) return { cardHash, status: 'approved' as const, reasons: none, approval: JSON.parse(approved.approval_json) as Record<string, string> };
    if (rejected(cardHash)) return { cardHash, status: 'rejected' as const, reasons: none, approval: null };
    const voided = getRow<{ reasons_json: string }>(db, 'SELECT reasons_json FROM veto_voids WHERE card_hash=?', cardHash);
    if (voided) return { cardHash, status: 'void' as const, reasons: JSON.parse(voided.reasons_json) as string[], approval: null };
    const shown = display(cardHash);
    if (!shown) return { cardHash, status: 'awaiting_display' as const, reasons: none, approval: null };
    if (now().getTime() < Date.parse(shown.window_ends_at)) return { cardHash, status: 'in_window' as const, reasons: none, approval: null };
    // Re-check everything at the window's end; the daily quota was spent at submission. A void is permanent.
    const active = grants.internalActive();
    const reasons = !active ? ['veto.no_active_grant'] : active.proposalId !== card.grant_proposal_id || active.subjectHash !== card.grant_subject_hash ? ['veto.grant_changed']
     : outsideGrant(JSON.parse(card.card_json) as TradeCard, active, cardHash).filter(r => r !== 'veto.daily_card_limit');
    if (reasons.length) { db.prepare('INSERT INTO veto_voids VALUES(?,?,?)').run(cardHash, canonicalJson(reasons), iso()); return { cardHash, status: 'void' as const, reasons, approval: null }; }
    const approval = { kind: 'standing_authorization_veto_window', cardHash, grantProposalId: card.grant_proposal_id, grantSubjectHash: card.grant_subject_hash, windowStartedAt: shown.displayed_at, windowEndedAt: shown.window_ends_at, approvedAt: iso() };
    db.prepare('INSERT INTO veto_approvals VALUES(?,?)').run(cardHash, canonicalJson(approval));
    return { cardHash, status: 'approved' as const, reasons: none, approval: approval as Record<string, string> };
   });
  },
 };
}
