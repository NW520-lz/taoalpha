import {z} from 'zod';
import {Decimal} from '../lib/decimal.ts';
import {DomainError} from '../lib/errors.ts';
import {getHistory} from '../market/history.ts';
import type {Db} from '../store/db.ts';
import {inspectBoundHistory} from './experiment-history.ts';
import {fundingEventsFor,loadRegisteredExperiment,tradeMetrics,windowCandles,type Registry} from './registered-replay.ts';
import {parseReplayInput} from './research-evaluation.ts';
import {atr,checkStop,fundingCost,tradeCosts,type Bar,type ExitReason} from './trend-replay.ts';

const requestSchema=z.strictObject({experimentId:z.string(),version:z.number(),expected:z.unknown(),window:z.enum(['exploration','validation','evaluation'])});
type Candle=ReturnType<typeof windowCandles>['candles'][number];
type SkipReason='turnover_not_expanded'|'not_stronger_than_benchmark'|'max_positions'|'no_entry_candle';
const toBar=(c:Candle):Bar=>({open:new Decimal(c.open),high:new Decimal(c.high),low:new Decimal(c.low),close:new Decimal(c.close)});

/**
 * Universe replay on the benchmark's bar timeline. At each close, instruments without a position that
 * break out are filtered by turnover expansion against their own recent mean, must beat the benchmark's
 * return over the strength lookback, and fill free slots strongest first; entries fill at the next open.
 * Exits follow the trend replay's trailing stop. Turnover is only compared with the same instrument.
 */
export function replayRelativeStrength(db:Db,registry:Registry,raw:unknown) {
 const request=parseReplayInput(requestSchema,raw);
 if(request.window==='evaluation') throw new DomainError('UNSUPPORTED_CAPABILITY','Evaluation window is sealed',[{ruleId:'experiment.evaluation_window_sealed'}]);
 const loaded=loadRegisteredExperiment(db,registry,request);
 const {registration,resolutionMs}=loaded, replay=registration.replay, selection=replay?.selection;
 const base={experimentId:request.experimentId,version:request.version,window:request.window,registrationSha256:registration.contentSha256,survivorshipGap:loaded.inspection.unknowns.includes('historical_universe_unknown'),status:'insufficient' as const,executionAuthorized:false as const};
 const blocked=(reasonCode:'rules_incomplete'|'missing_required_evidence')=>({...base,outcome:'blocked' as const,reasonCode,trades:null,skips:[],metrics:null});
 if(!replay || !selection || !registration.universe) return blocked('rules_incomplete');
 // Relative strength needs the benchmark at every bar of the window.
 const benchmark=windowCandles(loaded,request.window).candles;
 if(!benchmark.length || benchmark.some((c,k)=>k>0 && c.ts!==benchmark[k-1]!.ts+resolutionMs)) return blocked('missing_required_evidence');
 const {rule,cost}=replay, qty=new Decimal(replay.market.baseQuantity);
 const members=registration.universe.instruments.map(({data})=>{
  const inspection=inspectBoundHistory(db,registration,data);
  const member={...loaded,inspection,manifest:getHistory(db,inspection.reference)!};
  return {instId:data.scope.instId,byTs:new Map(windowCandles(member,request.window).candles.map(c=>[c.ts,c])),funding:fundingEventsFor(member,replay).fundingEvents ?? []};
 });
 type Member=typeof members[number];
 type Position={member:Member;signalOpenMs:number;entryOpenMs:number;entry:Decimal;initialStop:Decimal;distance:Decimal;highest:Decimal;range:Decimal;last:Candle|null};
 const need=Math.max(rule.breakoutLookback,rule.atrPeriod,selection.strengthLookback,selection.volumeLookback);
 // Bars k-need..k of a member, or null when any of them is missing.
 const history=(m:Member,k:number)=>{const out:Candle[]=[];for(let j=k-need;j<=k;j++){const c=m.byTs.get(benchmark[j]!.ts);if(!c) return null;out.push(c);}return out;};
 const settle=(p:Position,exit:Decimal,exitReason:ExitReason,exitOpenMs:number,exitInstant:number,endsAt:'window_end'|'data_gap')=>{
  const {gross,fees,impact}=tradeCosts(qty,p.entry,exit,cost);
  const funding=fundingCost(qty,[...p.member.byTs.values()],p.member.funding,p.entryOpenMs,exitInstant);
  return {instId:p.member.instId,signalOpenMs:p.signalOpenMs,entryOpenMs:p.entryOpenMs,exitOpenMs,exitReason,endsAt,atrAtSignal:p.range.toFixed(),initialStopPrice:p.initialStop.toFixed(),trailingDistance:p.distance.toFixed(),entryPrice:p.entry.toFixed(),exitPrice:exit.toFixed(),grossUsdt:gross.toFixed(),feesUsdt:fees.toFixed(),impactUsdt:impact.toFixed(),fundingUsdt:funding.toFixed(),netUsdt:gross.minus(fees).minus(impact).minus(funding).toFixed()};
 };
 // A position that cannot be followed further is only a mark at its last seen close.
 const mark=(p:Position,endsAt:'window_end'|'data_gap')=>settle(p,new Decimal(p.last?.close ?? p.entry),'end_of_data',p.last?.ts ?? p.entryOpenMs,p.last?.closeTime ?? p.entryOpenMs,endsAt);
 const open=new Map<string,Position>();
 const trades:Array<ReturnType<typeof settle>>=[], skips:Array<{instId:string;signalOpenMs:number;reason:SkipReason}>=[];
 for(let k=0;k<benchmark.length;k++) {
  const ts=benchmark[k]!.ts;
  for(const [instId,p] of open) {
   const c=p.member.byTs.get(ts);
   if(!c){trades.push(mark(p,'data_gap'));open.delete(instId);continue;}
   const hit=checkStop(toBar(c),p.initialStop,p.highest,p.distance);
   if(hit){trades.push(settle(p,hit.price,hit.reason,ts,hit.reason==='gap_through_stop' ? c.ts : c.closeTime,'window_end'));open.delete(instId);continue;}
   p.highest=Decimal.max(p.highest,new Decimal(c.high));p.last=c;
  }
  if(k<need) continue;
  const candidates:Array<{member:Member;strength:Decimal;bars:Bar[]}>=[];
  for(const member of members) {
   if(open.has(member.instId)) continue;
   const window=history(member,k); if(!window) continue;
   const bars=window.map(toBar), now=bars[need]!;
   const priorHigh=bars.slice(need-rule.breakoutLookback,need).reduce((h,b)=>Decimal.max(h,b.high),bars[need-1]!.high);
   if(!now.close.gt(priorHigh)) continue;
   const turnover=window.map(c=>new Decimal(c.volume.volCcyQuote));
   const mean=turnover.slice(need-selection.volumeLookback,need).reduce((s,v)=>s.plus(v),new Decimal(0)).div(selection.volumeLookback);
   if(turnover[need]!.lt(mean.times(selection.volumeMultiplier))){skips.push({instId:member.instId,signalOpenMs:ts,reason:'turnover_not_expanded'});continue;}
   const growth=(now:string,then:string)=>new Decimal(now).div(then);
   const strength=growth(window[need]!.close,window[need-selection.strengthLookback]!.close).minus(growth(benchmark[k]!.close,benchmark[k-selection.strengthLookback]!.close));
   if(!strength.gt(0)){skips.push({instId:member.instId,signalOpenMs:ts,reason:'not_stronger_than_benchmark'});continue;}
   candidates.push({member,strength,bars});
  }
  candidates.sort((x,y)=>y.strength.comparedTo(x.strength) || (x.member.instId<y.member.instId ? -1 : 1));
  for(const {member,bars} of candidates) {
   if(open.size>=selection.maxPositions){skips.push({instId:member.instId,signalOpenMs:ts,reason:'max_positions'});continue;}
   const entryCandle=k+1<benchmark.length ? member.byTs.get(benchmark[k+1]!.ts) : undefined;
   if(!entryCandle){skips.push({instId:member.instId,signalOpenMs:ts,reason:'no_entry_candle'});continue;}
   const range=atr(bars,need,rule.atrPeriod), entry=new Decimal(entryCandle.open);
   open.set(member.instId,{member,signalOpenMs:ts,entryOpenMs:entryCandle.ts,entry,initialStop:entry.minus(range.times(rule.initialStopAtr)),distance:range.times(rule.trailingStopAtr),highest:entry,range,last:null});
  }
 }
 for(const p of open.values()) trades.push(mark(p,'window_end'));
 trades.sort((x,y)=>x.exitOpenMs-y.exitOpenMs);
 return {...base,outcome:'replayed' as const,reasonCode:null,trades,skips,metrics:tradeMetrics(trades)};
}
