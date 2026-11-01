import {z} from 'zod';
import {Decimal} from '../lib/decimal.ts';
import {DomainError} from '../lib/errors.ts';
import {getHistory} from '../market/history.ts';
import type {Db} from '../store/db.ts';
import {inspectBoundHistory} from './experiment-history.ts';
import type {EvaluationGates} from './gates.ts';
import {loadRegisteredExperiment,replayWindow,timedTrades,tradeMetrics,type LoadedExperiment,type Registry,type WindowName} from './registered-replay.ts';
import {parseReplayInput} from './research-evaluation.ts';

const requestSchema=z.strictObject({experimentId:z.string(),version:z.number(),expected:z.unknown(),window:z.enum(['exploration','validation','evaluation'])});

/** Replays every universe member on one window, each against its own verified, frozen manifest. */
export function replayUniverse(db:Db,loaded:LoadedExperiment,name:WindowName) {
 const {registration,resolutionMs}=loaded;
 return registration.universe!.instruments.map(({group,data})=>{
  const inspection=inspectBoundHistory(db,registration,data);
  const window=replayWindow({...loaded,inspection,manifest:getHistory(db,inspection.reference)!},name);
  return {instId:data.scope.instId,group,metrics:window.metrics,trades:window.outcome==='replayed' ? timedTrades(window.segments,resolutionMs) : []};
 });
}

/** Totals, per-group and per-regime metrics on one exit-ordered timeline, judged against the frozen gates. */
export function judgeUniverse(members:ReturnType<typeof replayUniverse>,regimes:Array<{label:string;start:string;end:string}>,gates:EvaluationGates) {
 const all=members.flatMap(m=>m.trades).sort((a,b)=>a.exitOpenMs-b.exitOpenMs);
 const groupNames=[...new Set(members.map(m=>m.group))];
 const groups=groupNames.map(group=>({group,instruments:members.filter(m=>m.group===group).map(m=>m.instId),metrics:tradeMetrics(all.filter(t=>members.some(m=>m.group===group && m.trades.includes(t))))}));
 // A trade belongs to the regime in which it was entered.
 const byRegime=regimes.map(r=>({label:r.label,metrics:tradeMetrics(all.filter(t=>t.entryOpenMs>=Date.parse(r.start) && t.entryOpenMs<Date.parse(r.end)))}));
 const total=tradeMetrics(all), failed:string[]=[], insufficient:string[]=[];
 const positive=(m:{netUsdt:string|null})=>m.netUsdt!==null && new Decimal(m.netUsdt).gt(0);
 if(members.some(m=>!m.metrics)) insufficient.push('instrument_missing_evidence');
 if(total.realizedTrades<gates.minRealizedTrades) insufficient.push('universe_trades_below_minimum');
 const rule=gates.multiInstrument!;
 if(new Decimal(groups.filter(g=>positive(g.metrics)).length).div(groups.length).lt(rule.minPositiveGroupShare)) failed.push('positive_group_share_below_minimum');
 if(byRegime.filter(r=>positive(r.metrics)).length<rule.minPositiveRegimes) failed.push('positive_regimes_below_minimum');
 const universeGate=failed.length ? 'failed' as const : insufficient.length ? 'insufficient' as const : 'met' as const;
 return {instruments:members.map(({instId,group,metrics})=>({instId,group,metrics})),total,groups,regimes:byRegime,universeGate,reasons:[...failed,...insufficient]};
}

/** Read-only multi-instrument view of an exploration or validation window. */
export function aggregateUniverse(db:Db,registry:Registry,raw:unknown) {
 const request=parseReplayInput(requestSchema,raw);
 if(request.window==='evaluation') throw new DomainError('UNSUPPORTED_CAPABILITY','Evaluation window is sealed',[{ruleId:'experiment.evaluation_window_sealed'}]);
 const loaded=loadRegisteredExperiment(db,registry,request);
 const {registration,inspection}=loaded;
 // Instruments that later delisted are absent unless the historical universe is known.
 const base={experimentId:request.experimentId,version:request.version,window:request.window,registrationSha256:registration.contentSha256,survivorshipGap:inspection.unknowns.includes('historical_universe_unknown'),status:'insufficient' as const,executionAuthorized:false as const};
 if(!registration.universe || !registration.gates?.multiInstrument) return {...base,outcome:'blocked' as const,reasonCode:'rules_incomplete' as const,instruments:null,total:null,groups:null,regimes:null,universeGate:null,reasons:[]};
 return {...base,outcome:'aggregated' as const,reasonCode:null,...judgeUniverse(replayUniverse(db,loaded,request.window),registration.universe.regimes ?? [],registration.gates)};
}
