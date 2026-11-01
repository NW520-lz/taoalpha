import {openDb} from '../../src/store/db.ts';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {createExperimentRegistry} from '../../src/research/experiment-registry.ts';
import type {PublicClient} from '../../src/okx/public-client.ts';

export const H=3600000;
export const now=()=>new Date('2026-01-01T00:00:00.000Z');
// Hand-worked trend (bars 0-5, a breakout at bar 2 stopped at bar 5), then a later breakout at bar 7.
export const ohlc=[[100,101,99,100],[100,101,99,100],[100,104,100,104],[105,110,104,109],[109,115,108,114],[114,116,110,111],[111,112,110,111],[111,118,111,117],[118,119,117,118],[118,119,117,118],[118,119,117,118],[118,119,117,118]];
export const expected={site:'global',instId:'BTC-USDT',product:'spot',resolution:'1H'} as const;
export const replay={market:{product:'spot',quote:'USDT',baseQuantity:'2'},rule:{kind:'breakout_atr_trailing',breakoutLookback:2,atrPeriod:2,initialStopAtr:'2',trailingStopAtr:'1.5'},cost:{entryFeePpm:1000,exitFeePpm:1000,entryImpactPpm:2000,exitImpactPpm:2000,funding:'not_applicable'}};
const iso=(hour:number)=>new Date(hour*H).toISOString();
/** Registered windows by hour boundaries: exploration [0,a), validation [a,b), evaluation [b,c). */
export const windowsAt=(a:number,b:number,c:number)=>({exploration:{start:iso(0),end:iso(a)},validation:{start:iso(a),end:iso(b)},evaluation:{start:iso(b),end:iso(c)}});

/** Public OKX history candles as the fake client returns them: newest first, one page. */
export function fakeHistoryClient(bars:number[][],omit:number[]=[],funding:Array<{fundingTime:number;realizedRate:string}>=[]):PublicClient {
 // An optional fifth value per bar is its quote turnover (volCcy and volCcyQuote); default 100.
 const rows=bars.map((p,i)=>[String(i*H),...p.slice(0,4).map(String),'1',String(p[4] ?? 100),String(p[4] ?? 100),'1']).filter((_,i)=>!omit.includes(i)).reverse();
 const fundingRows=[...funding].reverse().map(f=>({instId:'BTC-USDT-SWAP',instType:'SWAP',fundingTime:String(f.fundingTime),fundingRate:f.realizedRate,realizedRate:f.realizedRate}));
 const pages:Record<string,unknown[][]>={'/api/v5/market/history-candles':[rows,[]],'/api/v5/public/funding-rate-history':[fundingRows,[]]};
 return {site:'global',async get<T>(path:string,query:Record<string,string>){
  const data=(pages[path]?.shift() ?? []) as T[]; const endpoint=path+'?'+new URLSearchParams(query);
  return {ok:true as const,endpoint,rows:data,raw:{endpoint,receivedAt:'1970-01-02T00:00:00.000Z',status:200,body:JSON.stringify({code:'0',data})}};
 }};
}

/** In-memory db with a saved 1H manifest of `bars` (BTC-USDT spot, or the perpetual with funding) and a matching registration input. */
export async function setup(omit:number[]=[],bars:number[][]=ohlc,perpetual?:{funding:Array<{fundingTime:number;realizedRate:string}>}) {
 const db=openDb(':memory:'); const registry=createExperimentRegistry(db,now);
 const scope=perpetual ? {...expected,instId:'BTC-USDT-SWAP',product:'usdt_perpetual'} as const : expected;
 const manifest=await collectHistory(fakeHistoryClient(bars,omit,perpetual?.funding),{instId:scope.instId,product:scope.product,resolution:'1H',start:0,end:bars.length*H,asOf:bars.length*H,limit:100,maxPages:2,capturedAt:'1970-01-02T00:00:00.000Z'});
 const id=saveHistory(db,manifest);
 const input={experimentId:'experiment:trend',version:1,attemptId:'attempt:trend:1',strategy:{id:'strategy:trend',version:1,entryRules:'close above prior highs',exitRules:'ATR initial and trailing stop',invalidationRules:'stop'},data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope},code:{reference:'code:trend',sha256:'b'.repeat(64),version:'v1'},costs:{fees:'10 bps per side',spread:'in impact',slippage:'20 bps per side',funding:'not applicable',execution:'next open'},windows:windowsAt(6,9,bars.length),evaluation:{metrics:'net',thresholds:'positive',baseline:'hold',method:'replay'},replay:perpetual ? {...replay,market:{...replay.market,product:'usdt_perpetual'},cost:{...replay.cost,funding:'realized_events'}} : replay};
 return {db,registry,manifest,input,scope};
}
