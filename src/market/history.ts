import type { PublicClient, RawResponse } from '../okx/public-client.ts';
import { dec, isDecimalString } from '../lib/decimal.ts';
import { canonicalJson, hashJson, sha256 } from '../lib/hash.ts';
import { inTransaction, type Db } from '../store/db.ts';

export const BARS = { '1m':60000,'5m':300000,'15m':900000,'1H':3600000,'4H':14400000,'1Dutc':86400000 } as const;
type Resolution = keyof typeof BARS;
export interface HistoryOptions { instId:string; product:'spot'|'usdt_perpetual'; resolution:Resolution; start:number; end:number; asOf:number; limit:number; maxPages:number; capturedAt:string; attemptId?:string; predecessorRef?:string; experimentRef?:string }
type Volume = { vol:string; volCcy:string; volCcyQuote:string; units:{vol:'base'|'contracts';volCcy:'quote'|'base';volCcyQuote:'quote'} };
type Candle = { ts:number; closeTime:number; open:string; high:string; low:string; close:string; volume:Volume };
type Funding = { fundingTime:number; fundingRate:string; realizedRate:string };
type Source = { endpoint:string; receivedAt:string|null; status:number|null; body:string|null; sha256:string|null; error:string|null };
export interface HistoryManifest {
 schemaVersion:1; parsingVersion:'okx-history-v1'; site:string; request:HistoryOptions; capturedAt:string;
 sources:Source[]; candles:Candle[]; funding:{ status:'not_applicable'|'unknown'; events:Funding[] };
 candleCoverage:'complete'|'partial'; returnedRange:{first:number;last:number}|null; gaps:string[];
 availability:'historical_publication_unverified'; historicalUniverse:'unknown_survivorship_gap';
 strategyValid:false; executionAuthorized:false;
}
function validTime(n:unknown): n is number { return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0; }
function validate(o:HistoryOptions):void {
 if (!o || !/^[A-Z0-9]+-USDT(?:-SWAP)?$/.test(o.instId) || (o.product !== 'spot' && o.product !== 'usdt_perpetual') || (o.product === 'spot' ? o.instId.endsWith('-SWAP') : !o.instId.endsWith('-SWAP'))) throw Error('invalid instrument or product');
 if (!Object.hasOwn(BARS,o.resolution)) throw Error('invalid resolution');
 if (![o.start,o.end,o.asOf].every(validTime) || o.end<=o.start || o.end>Number.MAX_SAFE_INTEGER-1 || o.start % BARS[o.resolution] || o.end % BARS[o.resolution] || (o.end-o.start)/BARS[o.resolution]>100000) throw Error('invalid window');
 if (!Number.isInteger(o.limit)||o.limit<1||o.limit>100||!Number.isInteger(o.maxPages)||o.maxPages<1||o.maxPages>1000) throw Error('invalid pagination bounds');
 if (typeof o.capturedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(o.capturedAt)||!Number.isFinite(Date.parse(o.capturedAt)) || new Date(o.capturedAt).toISOString()!==o.capturedAt || Date.parse(o.capturedAt)<o.asOf) throw Error('invalid capturedAt');
 for(const s of [o.attemptId,o.predecessorRef,o.experimentRef]) if(s!==undefined && (typeof s!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(s))) throw Error('invalid reference');
}
function timestamp(v:unknown):number|null { if(typeof v!=='string'||!/^\d+$/.test(v)) return null; const n=Number(v); return validTime(n)?n:null; }
function decimals(a:unknown[]):a is string[] { return a.every(v=>typeof v==='string' && isDecimalString(v)); }
function rawSource(raw:RawResponse|null, endpoint:string, error:string|null):Source {
 if (!raw) return {endpoint,receivedAt:null,status:null,body:null,sha256:null,error};
 return {endpoint:raw.endpoint,receivedAt:raw.receivedAt,status:raw.status,body:raw.body,sha256:sha256(raw.body),error};
}
export async function collectHistory(client:PublicClient, o:HistoryOptions):Promise<HistoryManifest> {
 validate(o);
 const gaps:string[]=['historical_universe_unknown','historical_publication_time_unverified','historical_open_interest_missing','time_aligned_market_structure_missing'];
 const sources:Source[]=[]; const candleMap=new Map<number,Candle>(); const conflicts=new Set<number>(); const fundMap=new Map<number,Funding>();
 let candleIssue=false;
 const issue=(s:string)=>{ gaps.push(s); candleIssue=true; };
 async function pages(path:string, accept:(r:unknown)=>number|null, candle:boolean):Promise<void> {
  let cursor=o.end+1; let stopped=false;
  for(let page=0;page<o.maxPages;page++) {
   const query:Record<string,string>={instId:o.instId,after:String(cursor),limit:String(o.limit)};
   if(candle) query.bar=o.resolution;
   let result;
   try { result=await client.get<unknown>(path,query); } catch { sources.push(rawSource(null,`${path}?${new URLSearchParams(query)}`,'client_failure')); gaps.push(`${candle?'candle':'funding'}_source_failed`); if(candle)candleIssue=true; stopped=true; break; }
   sources.push(rawSource(result.raw,result.endpoint,result.ok?null:result.error.kind));
   if(!result.ok) { gaps.push(`${candle?'candle':'funding'}_source_failed`); if(candle)candleIssue=true; stopped=true; break; }
   let previous=Infinity; let min=Infinity;
   for(const row of result.rows) {
    const ts=accept(row);
    if(ts===null) continue;
    if(ts>=previous) { gaps.push(`${candle?'candle':'funding'}_unsorted_or_duplicate:${ts}`); if(candle)candleIssue=true; }
    if(ts>=cursor) { gaps.push(`${candle?'candle':'funding'}_cursor_violation:${ts}`); if(candle)candleIssue=true; }
    previous=ts; min=Math.min(min,ts);
   }
   if(result.rows.length<o.limit || min<o.start || result.rows.length===0) { stopped=true; break; }
   if(!Number.isFinite(min)||min>=cursor) { gaps.push(`${candle?'candle':'funding'}_cursor_stalled`); if(candle)candleIssue=true; stopped=true; break; }
   cursor=min;
  }
  if(!stopped) { gaps.push(`${candle?'candle':'funding'}_page_cap`); if(candle)candleIssue=true; }
 }
 await pages('/api/v5/market/history-candles',(r)=>{
  if(!Array.isArray(r)||r.length!==9) { issue('candle_malformed_shape'); return null; }
  const ts=timestamp(r[0]);
  if(ts===null) { issue('candle_invalid_timestamp'); return null; }
  if(ts<o.start||ts>=o.end) return ts;
  if(ts % BARS[o.resolution] || !decimals(r.slice(1,8)) || r[8]!=='1' || ts+BARS[o.resolution]>o.asOf) { issue(`candle_invalid_or_unclosed:${ts}`); return ts; }
  const [op,hi,lo,cl,v,vc,vcq]=(r.slice(1,8) as string[]).map(dec);
  if ([op!,hi!,lo!,cl!].some(x=>!x.isPositive() || x.isZero()) || [v!,vc!,vcq!].some(x=>x.isNegative() && !x.isZero()) || hi!.lt(lo!) || op!.lt(lo!) || op!.gt(hi!) || cl!.lt(lo!) || cl!.gt(hi!)) { issue(`candle_invalid_values:${ts}`); return ts; }
  const [open,high,low,close,vol,volCcy,volCcyQuote]=r.slice(1,8) as string[];
  const candle:Candle={ts,closeTime:ts+BARS[o.resolution],open:open!,high:high!,low:low!,close:close!,volume:{vol:vol!,volCcy:volCcy!,volCcyQuote:volCcyQuote!,units:o.product==='spot'?{vol:'base',volCcy:'quote',volCcyQuote:'quote'}:{vol:'contracts',volCcy:'base',volCcyQuote:'quote'}}};
  const prior=candleMap.get(ts); if(prior && hashJson(prior)!==hashJson(candle)) { conflicts.add(ts); candleMap.delete(ts); issue(`candle_conflict:${ts}`); } else if(!conflicts.has(ts)) candleMap.set(ts,candle);
  return ts;
 },true);
 for(let ts=o.start;ts<o.end;ts+=BARS[o.resolution]) if(!candleMap.has(ts)) issue(`candle_missing:${ts}`);
 if(o.product==='usdt_perpetual') {
  gaps.push('funding_completeness_unknown','funding_public_rates_not_account_fees');
  await pages('/api/v5/public/funding-rate-history',(r)=>{
   if(typeof r!=='object'||r===null) { gaps.push('funding_malformed'); return null; }
   const v=r as Record<string,unknown>; const ts=timestamp(v.fundingTime);
   if(ts===null) { gaps.push('funding_invalid_timestamp'); return null; }
   if(v.instId!==o.instId||v.instType!=='SWAP'||!decimals([v.fundingRate,v.realizedRate])||ts>o.asOf) { gaps.push(`funding_invalid_or_future:${ts}`); return ts; }
   if(ts<o.start||ts>=o.end) return ts;
   const f:Funding={fundingTime:ts,fundingRate:v.fundingRate as string,realizedRate:v.realizedRate as string};
   const prior=fundMap.get(ts); if(prior&&hashJson(prior)!==hashJson(f)) { fundMap.delete(ts); gaps.push(`funding_conflict:${ts}`); } else if(!gaps.includes(`funding_conflict:${ts}`)) fundMap.set(ts,f);
   return ts;
  },false);
  if(!fundMap.size) gaps.push('funding_no_observed_events');
 }
 const candles=[...candleMap.values()].sort((a,b)=>a.ts-b.ts);
 return {schemaVersion:1,parsingVersion:'okx-history-v1',site:client.site,request:{instId:o.instId,product:o.product,resolution:o.resolution,start:o.start,end:o.end,asOf:o.asOf,limit:o.limit,maxPages:o.maxPages,capturedAt:o.capturedAt,...(o.attemptId===undefined?{}:{attemptId:o.attemptId}),...(o.predecessorRef===undefined?{}:{predecessorRef:o.predecessorRef}),...(o.experimentRef===undefined?{}:{experimentRef:o.experimentRef})},capturedAt:o.capturedAt,sources,candles,funding:{status:o.product==='spot'?'not_applicable':'unknown',events:[...fundMap.values()].sort((a,b)=>a.fundingTime-b.fundingTime)},candleCoverage:candleIssue?'partial':'complete',returnedRange:candles.length?{first:candles[0]!.ts,last:candles.at(-1)!.ts}:null,gaps,availability:'historical_publication_unverified',historicalUniverse:'unknown_survivorship_gap',strategyValid:false,executionAuthorized:false};
}
function migrate(db:Db):void {
 db.exec(`CREATE TABLE IF NOT EXISTS history_schema (version INTEGER PRIMARY KEY CHECK(version=1));
 CREATE TABLE IF NOT EXISTS history_manifests (id TEXT PRIMARY KEY, attempt_id TEXT UNIQUE, content TEXT NOT NULL, content_sha256 TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS history_schema_no_update BEFORE UPDATE ON history_schema BEGIN SELECT RAISE(ABORT,'history schema is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS history_schema_no_delete BEFORE DELETE ON history_schema BEGIN SELECT RAISE(ABORT,'history schema is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS history_schema_no_replace BEFORE INSERT ON history_schema WHEN EXISTS (SELECT 1 FROM history_schema WHERE version=NEW.version) BEGIN SELECT RAISE(ABORT,'history schema conflict'); END;
 CREATE TRIGGER IF NOT EXISTS history_manifests_no_update BEFORE UPDATE ON history_manifests BEGIN SELECT RAISE(ABORT,'history is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS history_manifests_no_delete BEFORE DELETE ON history_manifests BEGIN SELECT RAISE(ABORT,'history is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS history_manifests_no_replace BEFORE INSERT ON history_manifests WHEN EXISTS (SELECT 1 FROM history_manifests WHERE id=NEW.id OR (NEW.attempt_id IS NOT NULL AND attempt_id=NEW.attempt_id)) BEGIN SELECT RAISE(ABORT,'history conflict'); END;
 INSERT INTO history_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM history_schema WHERE version=1);`);
}
export function saveHistory(db:Db,m:HistoryManifest):string {
 const content=canonicalJson(m); const hash=sha256(content); const id=`history_${hash}`;
 return inTransaction(db,()=>{ migrate(db); const old=db.prepare('SELECT id, content FROM history_manifests WHERE id = ? OR (? IS NOT NULL AND attempt_id = ?)').get(id,m.request.attemptId??null,m.request.attemptId??null) as {id:string;content:string}|undefined;
  if(old) { if(old.id!==id||old.content!==content) throw Error('history attempt conflict'); return id; }
  db.prepare('INSERT INTO history_manifests(id,attempt_id,content,content_sha256) VALUES(?,?,?,?)').run(id,m.request.attemptId??null,content,hash); return id; });
}
export function getHistory(db:Db,id:string):HistoryManifest|null {
 if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_manifests'").get()) inTransaction(db,()=>migrate(db));
 const row=db.prepare('SELECT content,content_sha256 FROM history_manifests WHERE id=?').get(id) as {content:string;content_sha256:string}|undefined;
 if(!row)return null; if(sha256(row.content)!==row.content_sha256||id!==`history_${row.content_sha256}`) throw Error('history integrity failure'); return JSON.parse(row.content) as HistoryManifest;
}
