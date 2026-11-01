// Experiment btc-4h-trend v1 (ticket 03): parameters, costs, windows and gates confirmed by the user on 2026-11-01.
// Reads only OKX public market data. Rule fixed before running: the one-shot final evaluation runs only if
// both the validation gate and the sensitivity gate are met; otherwise the evaluation window stays sealed.
// Usage: node scripts/research/btc-4h-trend-v0.ts   (TAOALPHA_DB overrides data/taoalpha.db)
import {readFileSync} from 'node:fs';
import {sha256} from '../../src/lib/hash.ts';
import {collectHistory,saveHistory} from '../../src/market/history.ts';
import {createPublicClient,type PublicClient} from '../../src/okx/public-client.ts';
import {openDb} from '../../src/store/db.ts';
import {compareWithBaselines} from '../../src/research/baselines.ts';
import {createExperimentRegistry} from '../../src/research/experiment-registry.ts';
import {runFinalEvaluation} from '../../src/research/final-evaluation.ts';
import {assessParameterSensitivity} from '../../src/research/sensitivity.ts';
import {judgeValidation} from '../../src/research/validation-judgement.ts';

const EXPERIMENT='btc-4h-trend', VERSION=1;
const scope={site:'global',instId:'BTC-USDT',product:'spot',resolution:'4H'} as const;
const start=Date.UTC(2019,0,1), end=Date.UTC(2026,9,1);
const ENGINE_FILES=['src/research/trend-replay.ts','src/research/registered-replay.ts','src/research/validation-judgement.ts','src/research/baselines.ts','src/research/sensitivity.ts','src/research/final-evaluation.ts'];

// OKX allows 20 history-candle requests per 2 seconds; space them out instead of retrying.
function throttled(client:PublicClient,gapMs:number):PublicClient {
 let last=0;
 return {site:client.site,async get(path,query){const wait=last+gapMs-Date.now();if(wait>0) await new Promise(r=>setTimeout(r,wait));last=Date.now();return client.get(path,query);}};
}

const db=openDb(process.env.TAOALPHA_DB ?? 'data/taoalpha.db');
try {
 const registry=createExperimentRegistry(db,()=>new Date());
 if(!registry.get(EXPERIMENT,VERSION)) {
  const manifest=await collectHistory(throttled(createPublicClient(),150),{instId:scope.instId,product:scope.product,resolution:scope.resolution,start,end,asOf:end,limit:100,maxPages:300,capturedAt:new Date().toISOString(),attemptId:`${EXPERIMENT}-v${VERSION}-history`,experimentRef:`${EXPERIMENT}:${VERSION}`});
  const id=saveHistory(db,manifest);
  const engine=ENGINE_FILES.map(f=>readFileSync(f,'utf8')).join('\n');
  registry.register({experimentId:EXPERIMENT,version:VERSION,attemptId:`${EXPERIMENT}-v${VERSION}`,
   strategy:{id:'breakout-atr-trailing',version:1,entryRules:'4H close above the prior 20 highs; enter at the next open',exitRules:'initial stop entry-2xATR(14); trailing stop highest prior high-3xATR(14) frozen at signal; no fixed take profit',invalidationRules:'stop hit'},
   data:{reference:id,sha256:id.slice(8),version:manifest.parsingVersion,scope},
   code:{reference:'engine:breakout-atr-trailing-v2',sha256:sha256(engine),version:'breakout-atr-trailing-v2'},
   costs:{fees:'OKX spot regular taker 0.10% per side (assumed, not the personal fee tier)',spread:'included in impact',slippage:'0.05% per side at the next open',funding:'not applicable (spot)',execution:'market at next 4H open; stops at stop level or open on gaps'},
   windows:{exploration:{start:'2019-01-01T00:00:00Z',end:'2023-01-01T00:00:00Z'},validation:{start:'2023-01-01T00:00:00Z',end:'2025-01-01T00:00:00Z'},evaluation:{start:'2025-01-01T00:00:00Z',end:'2026-10-01T00:00:00Z'}},
   evaluation:{metrics:'realized net, drawdown, win rate, cost share, hold comparison',thresholds:'structured gates',baseline:'hold BTC and no trade on the same window',method:'closed-candle replay; pilot with weak statistical power (single instrument)'},
   replay:{market:{product:'spot',quote:'USDT',baseQuantity:'0.01'},rule:{kind:'breakout_atr_trailing',breakoutLookback:20,atrPeriod:14,initialStopAtr:'2',trailingStopAtr:'3'},cost:{entryFeePpm:1000,exitFeePpm:1000,entryImpactPpm:500,exitImpactPpm:500,funding:'not_applicable'}},
   gates:{minRealizedTrades:60,maxValidationDecay:'0.4',normalizationDays:30,requirePositiveNet:true,costStressMultipliers:[1,2,3],costStressMustStayPositiveAt:2,requireBeatHold:false,
    sensitivity:{neighbourhoods:{breakoutLookback:[10,15,20,25,30],atrPeriod:[7,10,14,18,21],initialStopAtr:['1','1.5','2','2.5','3'],trailingStopAtr:['2','2.5','3','3.5','4']},stopGrid:{initialStopAtr:['1.5','2','2.5'],trailingStopAtr:['2.5','3','3.5','4']},maxAdjacentChange:'0.5',requireAllPositive:true}},
  });
 }
 const request={experimentId:EXPERIMENT,version:VERSION,expected:scope};
 const validation=judgeValidation(db,registry,request);
 const sensitivity=assessParameterSensitivity(db,registry,request);
 const exploration=compareWithBaselines(db,registry,{...request,window:'exploration'});
 const validationBaselines=compareWithBaselines(db,registry,{...request,window:'validation'});
 const unsealed=validation.validationGate==='met' && sensitivity.sensitivityGate==='met';
 const final=unsealed ? runFinalEvaluation(db,registry,request,()=>new Date()) : null;
 const strip=(w:{segments?:unknown}|null)=>w && {...w,segments:undefined};
 process.stdout.write(JSON.stringify({validation:{...validation,exploration:strip(validation.exploration),validation:strip(validation.validation)},sensitivity,baselines:{exploration,validation:validationBaselines},finalEvaluation:final ? {...final,evaluation:strip(final.evaluation),validation:undefined,sensitivity:undefined} : 'sealed: validation or sensitivity gate not met'},null,1)+'\n');
} finally { db.close(); }
