import {z} from 'zod';
import {Decimal} from '../lib/decimal.ts';
import {DomainError} from '../lib/errors.ts';
import type {Db} from '../store/db.ts';
import {fundingCost,tradeCosts} from './trend-replay.ts';
import {fundingEventsFor,loadRegisteredExperiment,replayWindow,windowCandles,type LoadedExperiment,type RegisteredReplay,type Registry,type WindowName} from './registered-replay.ts';
import {parseReplayInput} from './research-evaluation.ts';

const requestSchema=z.strictObject({experimentId:z.string(),version:z.number(),expected:z.unknown(),window:z.enum(['exploration','validation','evaluation'])});

/**
 * Buy the window's first open, sell its last close, same quantity and cost model as the strategy.
 * Drawdown is on close-to-close gross marks from zero; gaps are held through.
 */
function holdBaseline(loaded:LoadedExperiment,name:WindowName,replay:RegisteredReplay) {
 const {candles}=windowCandles(loaded,name);
 if(!candles.length) return null;
 const qty=new Decimal(replay.market.baseQuantity), entry=new Decimal(candles[0]!.open), exit=new Decimal(candles.at(-1)!.close);
 const {gross,fees,impact}=tradeCosts(qty,entry,exit,replay.cost);
 const funding=fundingCost(qty,candles,fundingEventsFor(loaded,replay).fundingEvents ?? [],candles[0]!.ts,candles.at(-1)!.closeTime);
 let peak=new Decimal(0), drawdown=new Decimal(0);
 for(const c of candles){const mark=qty.times(new Decimal(c.close).minus(entry));peak=Decimal.max(peak,mark);drawdown=Decimal.max(drawdown,peak.minus(mark));}
 return {entryPrice:entry.toFixed(),exitPrice:exit.toFixed(),grossUsdt:gross.toFixed(),feesUsdt:fees.toFixed(),impactUsdt:impact.toFixed(),fundingUsdt:funding.toFixed(),netUsdt:gross.minus(fees).minus(impact).minus(funding).toFixed(),maxDrawdownUsdt:drawdown.toFixed()};
}

/** The strategy at each multiplier of its registered costs, beside hold and no-trade on the same window. */
export function stressAndBaselines(loaded:LoadedExperiment,name:WindowName,replay:RegisteredReplay,multipliers:number[]) {
 const scaled=(m:number):RegisteredReplay=>({...replay,cost:{...replay.cost,entryFeePpm:replay.cost.entryFeePpm*m,exitFeePpm:replay.cost.exitFeePpm*m,entryImpactPpm:replay.cost.entryImpactPpm*m,exitImpactPpm:replay.cost.exitImpactPpm*m}}) as RegisteredReplay;
 return {
  costStress:multipliers.map(multiplier=>({multiplier,metrics:replayWindow(loaded,name,scaled(multiplier)).metrics})),
  hold:holdBaseline(loaded,name,replay),
  noTrade:{netUsdt:'0',maxDrawdownUsdt:'0'},
 };
}

/** Read-only robustness view of an exploration or validation window. */
export function compareWithBaselines(db:Db,registry:Registry,raw:unknown) {
 const request=parseReplayInput(requestSchema,raw);
 if(request.window==='evaluation') throw new DomainError('UNSUPPORTED_CAPABILITY','Evaluation window is sealed',[{ruleId:'experiment.evaluation_window_sealed'}]);
 const loaded=loadRegisteredExperiment(db,registry,request);
 const {registration}=loaded;
 const base={experimentId:request.experimentId,version:request.version,window:request.window,registrationSha256:registration.contentSha256,status:'insufficient' as const,executionAuthorized:false as const};
 if(!registration.replay || !registration.gates?.costStressMultipliers) return {...base,outcome:'blocked' as const,reasonCode:'rules_incomplete' as const,costStress:null,hold:null,noTrade:null};
 return {...base,outcome:'compared' as const,reasonCode:null,...stressAndBaselines(loaded,request.window,registration.replay,registration.gates.costStressMultipliers)};
}
