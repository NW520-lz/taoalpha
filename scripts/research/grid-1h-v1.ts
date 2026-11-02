// Grid v1 (ticket 19): one experiment per coin, parameters confirmed by the user on 2026-11-01.
// Reads only OKX public market data. Quantity per slot is the coin amount worth 0.001 BTC at the latest UTC daily
// close when first registered (sizing only; signals never see it). Fixed before running: each coin's one-shot final
// evaluation runs only if that coin's validation and sensitivity gates are both met. Multi-instrument rule, frozen
// in each registration: both groups (BTC+ETH, LTC+XRP) must have positive summed net in exploration and validation,
// and at least 3 of the 4 coins must be positive in both. Kept as a frozen script per experiment.
// Usage: node scripts/research/grid-1h-v1.ts   (TAOALPHA_DB overrides data/taoalpha.db)
import {readFileSync} from 'node:fs';
import {Decimal} from '../../src/lib/decimal.ts';
import {sha256} from '../../src/lib/hash.ts';
import {collectHistory,getHistory,saveHistory} from '../../src/market/history.ts';
import {createPublicClient,type PublicClient} from '../../src/okx/public-client.ts';
import {openDb,type Db} from '../../src/store/db.ts';
import {compareWithBaselines} from '../../src/research/baselines.ts';
import {createExperimentRegistry} from '../../src/research/experiment-registry.ts';
import {runFinalEvaluation} from '../../src/research/final-evaluation.ts';
import {assessParameterSensitivity} from '../../src/research/sensitivity.ts';
import {judgeValidation} from '../../src/research/validation-judgement.ts';

const COINS=[{instId:'BTC-USDT',group:'majors'},{instId:'ETH-USDT',group:'majors'},{instId:'LTC-USDT',group:'large_alts'},{instId:'XRP-USDT',group:'large_alts'}] as const;
const VERSION=1, start=Date.UTC(2019,0,1), end=Date.UTC(2026,9,1);
const ENGINE_FILES=['src/research/grid-replay.ts','src/research/trend-replay.ts','src/research/registered-replay.ts','src/research/validation-judgement.ts','src/research/baselines.ts','src/research/sensitivity.ts','src/research/final-evaluation.ts'];
const rule={kind:'grid_spot',rangeFraction:'0.1',gridCount:10,spacing:'geometric',stopFraction:'0.15'} as const;
const cost={entryFeePpm:800,exitFeePpm:800,entryImpactPpm:200,exitImpactPpm:200,funding:'not_applicable'} as const;
const gates={minRealizedTrades:200,maxValidationDecay:'0.4',normalizationDays:30,requirePositiveNet:true,costStressMultipliers:[1,2,3],costStressMustStayPositiveAt:2,requireBeatHold:false,maxEquityDrawdownUsdt:'50',
 sensitivity:{neighbourhoods:{gridCount:[6,8,10,12,14],rangeFraction:['0.06','0.08','0.1','0.12','0.14'],stopFraction:['0.12','0.15','0.18']},maxAdjacentChange:'0.5',requireAllPositive:true}};
const MULTI='Multi-instrument rule (frozen for grid v1): both groups (BTC+ETH, LTC+XRP) must have positive summed net in exploration and validation, and at least 3 of the 4 coins must be positive after costs in both windows.';

// OKX allows 20 history-candle requests per 2 seconds; space them out instead of retrying.
function throttled(client:PublicClient,gapMs:number):PublicClient {
 let last=0;
 return {site:client.site,async get(path,query){const wait=last+gapMs-Date.now();if(wait>0) await new Promise(r=>setTimeout(r,wait));last=Date.now();return client.get(path,query);}};
}
const client=throttled(createPublicClient(),150);

async function latestDailyClose(instId:string):Promise<Decimal> {
 const r=await client.get<string[]>('/api/v5/market/candles',{instId,bar:'1Dutc',limit:'3'});
 if(!r.ok) throw Error(`daily candle unavailable for ${instId}`);
 return new Decimal(r.rows.find(row=>row[8]==='1')![4]!);
}

// Reuse a capture already saved under this attempt (e.g. when an earlier run stopped after collection).
async function history(db:Db,instId:string,experiment:string) {
 const attemptId=`${experiment}-v${VERSION}-history`;
 const saved=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_manifests'").get() ? db.prepare('SELECT id FROM history_manifests WHERE attempt_id=?').get(attemptId) as {id:string}|undefined : undefined;
 if(saved) return {id:saved.id,manifest:getHistory(db,saved.id)!};
 const manifest=await collectHistory(client,{instId,product:'spot',resolution:'1H',start,end,asOf:end,limit:100,maxPages:1000,capturedAt:new Date().toISOString(),attemptId,experimentRef:`${experiment}:${VERSION}`});
 return {id:saveHistory(db,manifest),manifest};
}

const db=openDb(process.env.TAOALPHA_DB ?? 'data/taoalpha.db');
try {
 const registry=createExperimentRegistry(db,()=>new Date());
 const btcClose=await latestDailyClose('BTC-USDT');
 const results:Array<{instId:string;group:string;explorationNetUsdt:string|null;validationNetUsdt:string|null;detail:unknown}>=[];
 for(const {instId,group} of COINS) {
  const experiment=`grid-1h-${instId.split('-')[0]!.toLowerCase()}`;
  const scope={site:'global',instId,product:'spot',resolution:'1H'} as const;
  if(!registry.get(experiment,VERSION)) {
   const close=instId==='BTC-USDT' ? btcClose : await latestDailyClose(instId);
   const baseQuantity=new Decimal('0.001').times(btcClose).div(close).toSignificantDigits(3).toFixed();
   const {id,manifest}=await history(db,instId,experiment);
   const engine=ENGINE_FILES.map(f=>readFileSync(f,'utf8')).join('\n');
   registry.register({experimentId:experiment,version:VERSION,attemptId:`${experiment}-v${VERSION}`,
    strategy:{id:'grid-spot',version:1,entryRules:'spot grid centred on the reference price (previous 1H close, or the first open): 10 geometric lines across +/-10%; an empty slot rests a buy at its line only below the reference price',exitRules:'sell each slot at the next line up in a later bar; a stop 15% below the centre exits everything; re-centre when holding nothing and price has left the range, or after a stop',invalidationRules:'stop hit'},
    data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope},
    code:{reference:'engine:grid-spot-v2',sha256:sha256(engine),version:'grid-spot-v2'},
    costs:{fees:'OKX spot regular maker 0.08% per side (assumed, not the personal fee tier)',spread:'included in impact',slippage:'0.02% per side; stops are market exits and may slip more',funding:'not applicable (spot)',execution:'limit fills at line prices; intrabar order resolved against the strategy'},
    windows:{exploration:{start:'2019-01-01T00:00:00Z',end:'2023-01-01T00:00:00Z'},validation:{start:'2023-01-01T00:00:00Z',end:'2025-01-01T00:00:00Z'},evaluation:{start:'2025-01-01T00:00:00Z',end:'2026-10-01T00:00:00Z'}},
    evaluation:{metrics:'realized net, close-marked equity drawdown, realized drawdown, win rate, cost share, hold comparison',thresholds:`structured gates. ${MULTI}`,baseline:'hold the per-slot quantity and no trade on the same window',
     method:`closed 1H candle replay with worst-case intrabar order. Principal contradiction: range-bound oscillation that a grid harvests versus one-way moves that leave it holding inventory into its stop. Hypothesis: across 2019-2024 the harvested oscillation exceeds stop losses and costs. Quantity per slot ${baseQuantity} base coin = 0.001 BTC at the latest UTC daily close when registered (BTC ${btcClose.toFixed()}, ${instId} ${close.toFixed()}); a USDT drawdown limit therefore binds differently across years. Coins were chosen knowing they are still listed today (survivorship bias).`},
    replay:{market:{product:'spot',quote:'USDT',baseQuantity},rule,cost},gates});
  }
  const request={experimentId:experiment,version:VERSION,expected:scope};
  const validation=judgeValidation(db,registry,request);
  const sensitivity=assessParameterSensitivity(db,registry,request);
  const unsealed=validation.validationGate==='met' && sensitivity.sensitivityGate==='met';
  const strip=<T extends {segments?:unknown}|null>(w:T)=>w && {...w,segments:undefined};
  results.push({instId,group,explorationNetUsdt:validation.exploration?.metrics?.netUsdt ?? null,validationNetUsdt:validation.validation?.metrics?.netUsdt ?? null,detail:{experiment,registrationSha256:validation.registrationSha256,baseQuantity:registry.get(experiment,VERSION)!.replay!.market.baseQuantity,
   validation:{...validation,exploration:strip(validation.exploration),validation:strip(validation.validation)},sensitivity,
   baselines:{exploration:compareWithBaselines(db,registry,{...request,window:'exploration'}),validation:compareWithBaselines(db,registry,{...request,window:'validation'})},
   finalEvaluation:unsealed ? runFinalEvaluation(db,registry,request,()=>new Date()) : 'sealed: validation or sensitivity gate not met'}});
 }
 const net=(r:typeof results[number],w:'exploration'|'validation')=>new Decimal((w==='exploration' ? r.explorationNetUsdt : r.validationNetUsdt) ?? '0');
 const groups=[...new Set(results.map(r=>r.group))].map(group=>({group,exploration:results.filter(r=>r.group===group).reduce((s,r)=>s.plus(net(r,'exploration')),new Decimal(0)).toFixed(),validation:results.filter(r=>r.group===group).reduce((s,r)=>s.plus(net(r,'validation')),new Decimal(0)).toFixed()}));
 const positiveCoins=results.filter(r=>net(r,'exploration').gt(0) && net(r,'validation').gt(0)).map(r=>r.instId);
 const multiInstrument={rule:MULTI,groups,positiveCoins,met:groups.every(g=>new Decimal(g.exploration).gt(0) && new Decimal(g.validation).gt(0)) && positiveCoins.length>=3};
 process.stdout.write(JSON.stringify({results,multiInstrument},null,1)+'\n');
} finally { db.close(); }
