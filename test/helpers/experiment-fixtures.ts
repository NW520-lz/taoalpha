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
export function fakeHistoryClient(bars:number[][],omit:number[]=[]):PublicClient {
 const rows=bars.map((p,i)=>[String(i*H),...p.map(String),'1','100','100','1']).filter((_,i)=>!omit.includes(i)).reverse();
 const pages=[rows,[]];
 return {site:'global',async get<T>(path:string,query:Record<string,string>){
  const data=(pages.shift() ?? []) as T[]; const endpoint=path+'?'+new URLSearchParams(query);
  return {ok:true as const,endpoint,rows:data,raw:{endpoint,receivedAt:'1970-01-02T00:00:00.000Z',status:200,body:JSON.stringify({code:'0',data})}};
 }};
}

/** In-memory db with a saved manifest of `bars` (1H, BTC-USDT spot) and a matching registration input. */
export async function setup(omit:number[]=[],bars:number[][]=ohlc) {
 const db=openDb(':memory:'); const registry=createExperimentRegistry(db,now);
 const manifest=await collectHistory(fakeHistoryClient(bars,omit),{instId:'BTC-USDT',product:'spot',resolution:'1H',start:0,end:bars.length*H,asOf:bars.length*H,limit:100,maxPages:2,capturedAt:'1970-01-02T00:00:00.000Z'});
 const id=saveHistory(db,manifest);
 const input={experimentId:'experiment:trend',version:1,attemptId:'attempt:trend:1',strategy:{id:'strategy:trend',version:1,entryRules:'close above prior highs',exitRules:'ATR initial and trailing stop',invalidationRules:'stop'},data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope:expected},code:{reference:'code:trend',sha256:'b'.repeat(64),version:'v1'},costs:{fees:'10 bps per side',spread:'in impact',slippage:'20 bps per side',funding:'not applicable',execution:'next open'},windows:windowsAt(6,9,bars.length),evaluation:{metrics:'net',thresholds:'positive',baseline:'hold',method:'replay'},replay};
 return {db,registry,manifest,input};
}
