import { DomainError } from '../lib/errors.ts';
import { getRow, type Db } from '../store/db.ts';
import type { createDemoAccountSession } from './demo-session.ts';

export type DemoSnapshot = NonNullable<ReturnType<ReturnType<typeof createDemoAccountSession>['getInternalSnapshot']>>;

/**
 * The internal demo session snapshot, only if it is still fresh, unreconciled and non-executable, its scope
 * binding matches, its generation is the latest successful refresh, and the scope has no identity conflict.
 */
export function verifiedDemoSnapshot(db:Db, s:DemoSnapshot|null, nowMs:number):DemoSnapshot {
 const fail=():never=>{ throw new DomainError('INVALID_INPUT','Demo account snapshot rejected',[{ruleId:'demo_snapshot.rejected'}]); };
 if (!s || s.environment!=='demo' || s.reconciled!==false || s.executionAuthorized!==false || s.blockNewRisk!==true || !Number.isSafeInteger(s.generation) || !Number.isFinite(s.validUntilMs) || nowMs>s.validUntilMs) fail();
 const binding=getRow<{account_ref:string;site:string;environment:string}>(db,'SELECT account_ref,site,environment FROM demo_account_scopes WHERE scope_id=?',s!.scopeId);
 const event=getRow<{seq:number;status:string}>(db,'SELECT seq,status FROM demo_account_refresh_events WHERE scope_id=? ORDER BY seq DESC LIMIT 1',s!.scopeId);
 if (!binding || binding.account_ref!==s!.accountRef || binding.site!==s!.site || binding.environment!=='demo' || event?.seq!==s!.generation || event.status!=='ok' || getRow(db,'SELECT scope_id FROM demo_account_identity_conflicts WHERE scope_id=?',s!.scopeId)) fail();
 return s!;
}
