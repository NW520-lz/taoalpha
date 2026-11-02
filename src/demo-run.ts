import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDb, getRow } from './store/db.ts';
import { createDemoAccountSession } from './account/demo-session.ts';
import { normalizeDemoAccount } from './account/demo-account.ts';
import { createConfirmationService } from './control/confirmations.ts';
import { createWindowsPresence } from './control/windows-presence.ts';
import { createStandingAuthorizationService } from './control/standing-authorization.ts';
import { createVetoDisplay } from './control/veto-display.ts';
import { createDemoRiskPolicyService } from './risk/demo-risk-policy.ts';
import { createExperimentRegistry } from './research/experiment-registry.ts';
import { createPublicClient } from './okx/public-client.ts';
import { connectTradeKitDemoReader, connectTradeKitDemoWriter } from './okx/trade-kit-transport.ts';
import type { DemoSite } from './okx/trade-kit-demo-reader.ts';
import { PIPELINE_STRATEGY } from './trade/pipeline-signal.ts';
import { reconcileScope, runDemoCycle, type AccountRead, type CycleDeps, type Market } from './trade/demo-cycle.ts';

// Usage: npm run demo:run -- <setup|cycle|status|revoke> --profile taoalpha_demo --site global [--policy file] [--grant file]
// Demo only. Credentials stay in ~/.okx/config.toml and in the Trade Kit child process; output carries no amounts.
const { values, positionals } = parseArgs({ allowPositionals: true, options: { profile: { type: 'string' }, site: { type: 'string' }, policy: { type: 'string' }, grant: { type: 'string' } } });
const command = positionals[0], profile = values.profile ?? 'taoalpha_demo', site = (values.site ?? 'global') as DemoSite;
const SCOPE = 'scope:demo-main', now = () => new Date();
const db = openDb(process.env.TAOALPHA_DB ?? 'data/taoalpha.db');
const session = createDemoAccountSession(db, { scopeId: SCOPE, profile, site });
const confirmations = createConfirmationService(db, createWindowsPresence(), now);
const policies = createDemoRiskPolicyService(db, session, confirmations, now);
const grants = createStandingAuthorizationService(db, session, confirmations, now);
const refresh = async () => (await session.refresh()).status === 'bound';
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 1) + '\n');
const readers: Array<{ close(): Promise<void> }> = [];

/** The confirmed risk policy of this scope, mapped to the entry-risk fields the card compiler needs. */
function riskPolicy(version: number) {
 const row = getRow<{ subject_json: string }>(db, 'SELECT p.subject_json FROM demo_risk_policy_confirmations c JOIN demo_risk_policy_proposals p ON p.id=c.proposal_id WHERE c.scope_id=? AND c.version=?', SCOPE, version);
 if (!row) return null;
 const p = (JSON.parse(row.subject_json) as { payload: { policy: { version: number; budgetsUsdt: { spot: string; perpetual: string }; limits: { maxSpotAssets: number; maxPerpetualPositions: number; maxSpotPlanLossUsdt: string; maxPerpetualPlanLossUsdt: string; maxPerpetualLeverage: string } } } }).payload.policy;
 return { version: p.version, spotBudgetUsdt: p.budgetsUsdt.spot, perpetualBudgetUsdt: p.budgetsUsdt.perpetual, ...p.limits };
}

async function market(): Promise<Market> {
 const client = createPublicClient();
 const get = async (path: string, query: Record<string, string>) => { const r = await client.get<string[] | Record<string, string>>(path, query); if (!r.ok) throw new Error(`public ${path} unavailable`); return r.rows; };
 const candles = (await get('/api/v5/market/candles', { instId: 'BTC-USDT', bar: '4H', limit: '30' }) as string[][])
  .map(r => ({ ts: Number(r[0]), closeTime: Number(r[0]) + 4 * 3_600_000, open: r[1]!, high: r[2]!, low: r[3]!, close: r[4]!, confirmed: r[8] === '1' }));
 const [ticker] = await get('/api/v5/market/ticker', { instId: 'BTC-USDT' }) as Array<Record<string, string>>;
 const [inst] = await get('/api/v5/public/instruments', { instType: 'SPOT', instId: 'BTC-USDT' }) as Array<Record<string, string>>;
 return { candles, quote: { priceUsdt: ticker!.last!, at: new Date(Number(ticker!.ts)).toISOString(), sourceRef: `okx:ticker:BTC-USDT:${ticker!.ts}` },
  instrument: { instId: 'BTC-USDT', product: 'spot', baseCcy: inst!.baseCcy!, quoteCcy: 'USDT', state: inst!.state!, listTime: inst!.listTime || null, tickSz: inst!.tickSz!, lotSz: inst!.lotSz!, minSz: inst!.minSz!, ctVal: null } };
}

async function readAccount(): Promise<AccountRead> {
 const reader = await connectTradeKitDemoReader({ scopeId: SCOPE, profile, site }); readers.push(reader);
 const snapshot = await reader.refresh();
 return { snapshot, account: normalizeDemoAccount(snapshot, now()), orderByClientId: (instId, clOrdId) => reader.orderByClientId(instId, clOrdId), triggeredAlgos: (instId) => reader.triggeredAlgos(instId) };
}

/** Propose, confirm with Windows Hello, refresh the account, then bind the receipt. */
async function confirmWith(propose: () => { proposalId: string; requestId: string; status: string }, bind: (proposalId: string, receiptId: string) => { status: string }) {
 const proposal = propose();
 if (proposal.status !== 'pending') return proposal.status;
 const decision = await confirmations.reviewAndConfirm(proposal.requestId);
 if (decision.status !== 'verified' || !decision.receiptId) return decision.status;
 if (!(await refresh())) return 'account_unavailable';
 return bind(proposal.proposalId, decision.receiptId).status;
}

try {
 if (!(await refresh())) { print({ ok: false, stage: 'session', reason: 'demo account read unavailable' }); process.exitCode = 1; }
 else if (command === 'setup') {
  createExperimentRegistry(db, now).registerStrategy(PIPELINE_STRATEGY);
  const policy = JSON.parse(readFileSync(values.policy ?? '.scratch/m1-demo-loop/demo-policy.json', 'utf8')) as { version: number };
  const grant = JSON.parse(readFileSync(values.grant ?? '.scratch/m1-demo-loop/demo-grant.json', 'utf8')) as { version: number; validUntil: string };
  const tenMinutes = new Date(Date.now() + 600_000).toISOString();
  const policyStatus = await confirmWith(() => ({ ...policies.propose({ proposalId: `demo-policy-v${policy.version}`, policy, expiresAt: tenMinutes }), proposalId: `demo-policy-v${policy.version}` }), policies.confirm);
  const grantStatus = policyStatus === 'confirmed' || policyStatus === 'active' ? await confirmWith(() => grants.propose({ proposalId: `demo-grant-v${grant.version}`, grant, confirmBy: tenMinutes }), grants.confirm) : 'skipped';
  print({ ok: grantStatus === 'active', riskPolicy: policyStatus, standingGrant: grantStatus });
 } else if (command === 'cycle') {
  const deps: CycleDeps = { db, now, sleep: (ms) => new Promise(r => setTimeout(r, ms)), refreshSession: refresh, activeGrant: () => grants.internalActive(), riskPolicy, market, readAccount,
   display: createVetoDisplay(), openWriter: () => connectTradeKitDemoWriter({ scopeId: SCOPE, profile, site }), log: (line) => process.stderr.write(line + '\n') };
  print(await runDemoCycle(deps));
 } else if (command === 'status') {
  const active = grants.internalActive();
  const recon = active ? await reconcileScope(db, await readAccount(), active, Date.now()) : null;
  print({ standingGrant: active ? { proposalId: active.proposalId, validUntil: active.grant.validUntil, vetoWindowSeconds: active.grant.vetoWindowSeconds } : null,
   reconciliation: recon && { blockNewRisk: recon.blockNewRisk, reasons: recon.reasons, intents: recon.intents } });
 } else if (command === 'revoke') {
  const active = grants.internalActive();
  print(active ? grants.revoke(active.proposalId) : { status: 'no_active_grant' });
 } else { print({ ok: false, usage: 'npm run demo:run -- <setup|cycle|status|revoke> --profile taoalpha_demo --site global' }); process.exitCode = 2; }
} finally {
 for (const r of readers) await r.close().catch(() => {});
 db.close();
}
