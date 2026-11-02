// Ticket 19 diagnostic: how much does replaying the grid on 1H bars with worst-case intrabar order differ from 5m bars?
// Uses the registered grid-1h-btc v1 parameters on two exploration-window quarters only (never the evaluation window).
// Not a registered experiment and not a gate. 5m bars still use worst-case order inside each bar, so they are a
// finer approximation, not the true path. Run after grid-1h-v1.ts (shares the OKX public rate limit).
// Usage: node scripts/research/grid-5m-bias-check.ts   (TAOALPHA_DB overrides data/taoalpha.db)
import {Decimal} from '../../src/lib/decimal.ts';
import {collectHistory,getHistory,saveHistory} from '../../src/market/history.ts';
import {createPublicClient,type PublicClient} from '../../src/okx/public-client.ts';
import {openDb} from '../../src/store/db.ts';
import {createExperimentRegistry} from '../../src/research/experiment-registry.ts';
import {replayGridCandles} from '../../src/research/grid-replay.ts';

const PERIODS=[{label:'2020Q3 choppy',start:Date.UTC(2020,6,1),end:Date.UTC(2020,9,1)},{label:'2022 May-Jul crash',start:Date.UTC(2022,4,1),end:Date.UTC(2022,7,1)}];

function throttled(client:PublicClient,gapMs:number):PublicClient {
 let last=0;
 return {site:client.site,async get(path,query){const wait=last+gapMs-Date.now();if(wait>0) await new Promise(r=>setTimeout(r,wait));last=Date.now();return client.get(path,query);}};
}

const db=openDb(process.env.TAOALPHA_DB ?? 'data/taoalpha.db');
try {
 const registration=createExperimentRegistry(db,()=>new Date()).get('grid-1h-btc',1);
 if(!registration?.replay || registration.replay.rule.kind!=='grid_spot') throw Error('grid-1h-btc v1 is not registered');
 const replay=registration.replay, hourly=getHistory(db,registration.data.reference)!;
 const client=throttled(createPublicClient(),150);
 const summary=(candles:Array<{ts:number;closeTime:number;open:string;high:string;low:string;close:string}>,resolutionMs:number)=>{
  const r=replayGridCandles({schemaVersion:1,resolutionMs,candles:candles.map(({ts,closeTime,open,high,low,close})=>({ts,closeTime,open,high,low,close})),...replay});
  const realized=r.hypotheticalTrades.filter(t=>t.exitReason!=='end_of_data');
  const net=realized.reduce((s,t)=>s.plus(t.netUsdt),new Decimal(0));
  return {candles:candles.length,realizedTrades:realized.length,netUsdt:net.toFixed(),stops:r.stops.length,grids:r.grids.length,maxEquityDrawdownUsdt:r.maxEquityDrawdownUsdt};
 };
 const out=[];
 for(const p of PERIODS) {
  const attemptId=`grid-5m-bias-check-${p.start}`;
  const saved=db.prepare('SELECT id FROM history_manifests WHERE attempt_id=?').get(attemptId) as {id:string}|undefined;
  const fine=saved ? getHistory(db,saved.id)! : await collectHistory(client,{instId:'BTC-USDT',product:'spot',resolution:'5m',start:p.start,end:p.end,asOf:p.end,limit:100,maxPages:400,capturedAt:new Date().toISOString(),attemptId});
  if(!saved) saveHistory(db,fine);
  const coarse=hourly.candles.filter(c=>c.ts>=p.start && c.closeTime<=p.end);
  // Gaps would split a registered replay; this diagnostic only runs on complete periods.
  const complete=(cs:typeof coarse,ms:number)=>cs.length===(p.end-p.start)/ms;
  out.push({period:p.label,complete:{h1:complete(coarse,3600000),m5:complete(fine.candles,300000)},h1:summary(coarse,3600000),m5:summary(fine.candles,300000)});
 }
 process.stdout.write(JSON.stringify(out,null,1)+'\n');
} finally { db.close(); }
