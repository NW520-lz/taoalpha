import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/store/db.ts';
import { collectHistory, saveHistory, getHistory } from '../../src/market/history.ts';
import type { PublicClient } from '../../src/okx/public-client.ts';

const row = (t: number, confirm = '1') => [String(t),'10.01','11','9','10.5','2.25','22.5','22.500',''+confirm];
function fake(pages: Record<string, unknown[][]>): PublicClient {
 return { site: 'global', async get<T>(path: string, query: Record<string,string>) {
  assert.ok(['/api/v5/market/history-candles','/api/v5/public/funding-rate-history'].includes(path));
  const rows = (pages[path]?.shift() ?? []) as T[];
  const endpoint = path+'?'+new URLSearchParams(query);
  return {ok:true as const, endpoint, rows, raw:{endpoint,receivedAt:'2024-01-02T00:00:00.000Z',status:200,body:JSON.stringify({code:'0',data:rows})}};
 }};
}
const options = {instId:'BTC-USDT',product:'spot' as const,resolution:'1m' as const,start:0,end:120000,asOf:180000,limit:2,maxPages:3,capturedAt:'2024-01-02T00:00:00.000Z'};
test('closed candles retain exact values and spot units; immutable replay', async () => {
 const m=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000),row(0)],[]]}),options);
 assert.equal(m.candles.length,2); assert.equal(m.candles[0]?.volume.vol,'2.25');
 assert.equal(m.candles[0]?.volume.units.vol,'base'); assert.equal(m.candleCoverage,'complete');
 assert.equal(m.funding.status,'not_applicable'); assert.equal(m.executionAuthorized,false);
 const db=openDb(':memory:'); const id=saveHistory(db,m); assert.equal(saveHistory(db,m),id);
 assert.deepEqual(getHistory(db,id),m);
 assert.throws(()=>db.prepare('UPDATE history_manifests SET content = ? WHERE id = ?').run('{}',id));
 assert.throws(()=>db.prepare('DELETE FROM history_manifests WHERE id = ?').run(id));
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO history_manifests SELECT * FROM history_manifests WHERE id = ?').run(id)); db.close();
});
test('unclosed and malformed candles are gaps; missing is not complete', async () => {
 const m=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000,'0'),row(0).slice(0,8)]]}),options);
 assert.equal(m.candles.length,0); assert.equal(m.candleCoverage,'partial'); assert.ok(m.gaps.length>=2);
});
test('swap funding uses realized rate and contract units without completeness claim', async () => {
 const opts={...options,instId:'BTC-USDT-SWAP',product:'usdt_perpetual' as const};
 const f={instId:opts.instId,instType:'SWAP',fundingTime:'60000',fundingRate:'0.01',realizedRate:'-0.002'};
 const m=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000),row(0)],[]],'/api/v5/public/funding-rate-history':[[f]]}),opts);
 assert.equal(m.candles[0]?.volume.units.vol,'contracts'); assert.equal(m.funding.events[0]?.realizedRate,'-0.002'); assert.equal(m.funding.status,'unknown');
});

test('pagination cap, duplicate conflict and cursor violation stay partial', async () => {
 const capped=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000),row(0)]]}),{...options,maxPages:1});
 assert.ok(capped.gaps.includes('candle_page_cap')); assert.equal(capped.candleCoverage,'partial');
 const conflicting=[...row(60000)]; conflicting[1]='10.02';
 const dup=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000),conflicting],[row(60000),row(0)]]}),options);
 assert.ok(dup.gaps.includes('candle_conflict:60000')); assert.ok(dup.gaps.some(x=>x.startsWith('candle_cursor_violation'))); assert.equal(dup.candles.length,1);
});
test('failed source is explicit, input bounds and time prevent lookahead', async () => {
 const client:PublicClient={site:'global',async get<T>(path:string){return {ok:false as const,endpoint:path,error:{kind:'network' as const,message:'redacted'},raw:null};}};
 const m=await collectHistory(client,options); assert.ok(m.gaps.includes('candle_source_failed')); assert.equal(m.candleCoverage,'partial');
 await assert.rejects(()=>collectHistory(client,{...options,limit:101}));
 await assert.rejects(()=>collectHistory(client,{...options,instId:'BTC-USDT-SWAP'}));
 const recent=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000),row(0)]]}),{...options,asOf:119999});
 assert.equal(recent.candles.length,1); assert.ok(recent.gaps.includes('candle_invalid_or_unclosed:60000'));
});
test('attempt collisions fail; stored data survives database reopen', async () => {
 const { mkdtempSync, rmSync }=await import('node:fs'); const { tmpdir }=await import('node:os'); const { join }=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'history-')); const path=join(dir,'db.sqlite');
 try { const m=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000),row(0)]]}),{...options,attemptId:'try-1'});
  let db=openDb(path); const id=saveHistory(db,m); assert.throws(()=>saveHistory(db,{...m,gaps:[...m.gaps,'different']})); db.close();
  db=openDb(path); assert.deepEqual(getHistory(db,id),m); db.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('funding future, malformed and empty data remain unknown and observable', async () => {
 const opts={...options,instId:'BTC-USDT-SWAP',product:'usdt_perpetual' as const,asOf:90000};
 const funding={instId:opts.instId,instType:'SWAP',fundingTime:'100000',fundingRate:'0.001',realizedRate:'0.002'};
 const m=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000),row(0)]],'/api/v5/public/funding-rate-history':[[funding,{}]]}),opts);
 assert.equal(m.funding.events.length,0); assert.ok(m.gaps.includes('funding_invalid_or_future:100000')); assert.ok(m.gaps.includes('funding_invalid_timestamp')); assert.ok(m.gaps.includes('funding_no_observed_events'));
});
test('empty, unsorted and stalled pages do not silently yield complete coverage', async () => {
 const empty=await collectHistory(fake({}),options); assert.equal(empty.candleCoverage,'partial'); assert.ok(empty.gaps.includes('candle_missing:0'));
 const unsorted=await collectHistory(fake({'/api/v5/market/history-candles':[[row(0),row(60000)],[row(60000),row(60000)]]}),options);
 assert.ok(unsorted.gaps.some(x=>x.startsWith('candle_unsorted_or_duplicate'))); assert.ok(unsorted.gaps.includes('candle_cursor_stalled')); assert.equal(unsorted.candleCoverage,'partial');
});

test('negative and inconsistent candle values are gaps', async () => {
 for (const [field,value] of [[1,'-1'],[2,'8'],[3,'12'],[4,'12'],[5,'-0.01'],[6,'-1'],[7,'-1']] as const) {
  const bad=row(0); bad[field]=value;
  const m=await collectHistory(fake({'/api/v5/market/history-candles':[[row(60000),bad]]}),options);
  assert.equal(m.candleCoverage,'partial',`field ${field}`); assert.equal(m.candles.length,1);
 }
});
test('out-of-window candle at end is excluded before closedness check', async () => {
 const m=await collectHistory(fake({'/api/v5/market/history-candles':[[row(120000,'0'),row(60000)],[row(0)]]}),options);
 assert.equal(m.candleCoverage,'complete'); assert.equal(m.candles.length,2);
});
test('reading history from new db safely initializes and returns null', () => {
 const db=openDb(':memory:'); assert.equal(getHistory(db,'history_missing'),null); db.close();
});
