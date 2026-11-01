import {z} from 'zod';
import {Decimal} from '../lib/decimal.ts';
import {DomainError} from '../lib/errors.ts';
import {BARS,getHistory} from '../market/history.ts';
import type {Db} from '../store/db.ts';
import {inspectExperimentHistory} from './experiment-history.ts';
import type {createExperimentRegistry} from './experiment-registry.ts';
import {parseReplayInput} from './research-evaluation.ts';
import {replayTrendCandles} from './trend-replay.ts';

// Scope and identifiers are validated by inspectExperimentHistory; this only fixes the request shape.
const requestSchema=z.strictObject({experimentId:z.string(),version:z.number(),expected:z.unknown(),window:z.enum(['exploration','validation','evaluation'])});
type Registry=Pick<ReturnType<typeof createExperimentRegistry>,'get'>;
type Segment={endsAt:'window_end'|'data_gap';result:ReturnType<typeof replayTrendCandles>};

// Ratios and averages may not terminate; they are rounded half-even to 10 decimal places.
const ratio=(a:Decimal,b:Decimal)=>a.div(b).toDecimalPlaces(10,Decimal.ROUND_HALF_EVEN).toFixed();
const total=(list:Decimal[])=>list.reduce((a,b)=>a.plus(b),new Decimal(0));

/**
 * Window metrics over realized exits (stop or gap) in time order. A position still open when a
 * segment ends is only a close-price mark: at the window end it is reported separately, at a data
 * gap its outcome is unknown and it is only counted. Without realized exits amounts are null, not zero.
 */
function windowMetrics(segments:Segment[]) {
 const all=segments.flatMap(s=>s.result.hypotheticalTrades.map(t=>({...t,endsAt:s.endsAt})));
 const trades=all.filter(t=>t.exitReason!=='end_of_data');
 const marked=all.filter(t=>t.exitReason==='end_of_data' && t.endsAt==='window_end');
 const sum=(pick:(t:typeof trades[number])=>string)=>total(trades.map(t=>new Decimal(pick(t))));
 const gross=sum(t=>t.grossUsdt), fees=sum(t=>t.feesUsdt), impact=sum(t=>t.impactUsdt), net=sum(t=>t.netUsdt);
 const nets=trades.map(t=>new Decimal(t.netUsdt)), winners=nets.filter(n=>n.gt(0)), losers=nets.filter(n=>n.lte(0));
 // Drawdown of cumulative realized net, starting from zero.
 let cumulative=new Decimal(0), peak=new Decimal(0), drawdown=new Decimal(0);
 for(const n of nets){cumulative=cumulative.plus(n);peak=Decimal.max(peak,cumulative);drawdown=Decimal.max(drawdown,peak.minus(cumulative));}
 const any=trades.length>0, amount=(d:Decimal)=>any ? d.toFixed() : null;
 return {
  realizedTrades:trades.length,
  markedAtWindowEnd:{trades:marked.length,netUsdt:marked.length ? total(marked.map(t=>new Decimal(t.netUsdt))).toFixed() : null},
  unresolvedAtGap:all.length-trades.length-marked.length,
  grossUsdt:amount(gross),feesUsdt:amount(fees),impactUsdt:amount(impact),costUsdt:amount(fees.plus(impact)),netUsdt:amount(net),
  costToGrossRatio:gross.gt(0) ? ratio(fees.plus(impact),gross) : null,
  wins:winners.length,winRate:any ? ratio(new Decimal(winners.length),new Decimal(trades.length)) : null,
  averageWinUsdt:winners.length ? ratio(total(winners),new Decimal(winners.length)) : null,
  averageLossUsdt:losers.length ? ratio(total(losers),new Decimal(losers.length)) : null,
  maxDrawdownUsdt:amount(drawdown),tradeNetsUsdt:nets.map(n=>n.toFixed()),
 };
}

/**
 * Replays a registered experiment with only its frozen parameters, on only the candles of one
 * registered window of its bound history manifest. Read-only; never validates a strategy.
 */
export function replayRegisteredExperiment(db:Db,registry:Registry,raw:unknown) {
 const request=parseReplayInput(requestSchema,raw);
 // The final window may be looked at exactly once; that needs the persisted run-once report (slice #3).
 if(request.window==='evaluation') throw new DomainError('UNSUPPORTED_CAPABILITY','Evaluation window is sealed',[{ruleId:'experiment.evaluation_window_sealed'}]);
 const inspection=inspectExperimentHistory(db,registry,{experimentId:request.experimentId,version:request.version,expected:request.expected});
 const registration=registry.get(request.experimentId,request.version)!;
 const manifest=getHistory(db,inspection.reference)!;
 const window=registration.windows[request.window];
 const range={start:Date.parse(window.start),end:Date.parse(window.end)};
 const base={experimentId:request.experimentId,version:request.version,registrationSha256:registration.contentSha256,scopeBinding:inspection.expectedScopeBinding,history:{reference:inspection.reference,sha256:inspection.sha256},window:request.window,range,status:'insufficient' as const,executionAuthorized:false as const,unknowns:inspection.unknowns};
 // Prose rules are never interpreted into numbers; only frozen structured parameters run.
 if(!registration.replay) return {...base,outcome:'blocked' as const,reasonCode:'rules_incomplete' as const,segments:[],metrics:null};
 const replay=registration.replay;
 const resolutionMs=BARS[manifest.request.resolution];
 const inWindow=manifest.candles.filter(c=>c.ts>=range.start && c.closeTime<=range.end);
 // A missing candle splits the window; no position or signal is carried across a gap.
 if(!inWindow.length) return {...base,outcome:'blocked' as const,reasonCode:'missing_required_evidence' as const,segments:[],metrics:null};
 const pieces:typeof inWindow[]=[];
 for(const c of inWindow) {
  const last=pieces.at(-1)?.at(-1);
  if(last && c.ts===last.ts+resolutionMs) pieces.at(-1)!.push(c); else pieces.push([c]);
 }
 const segments=pieces.map(candles=>{
  // A bound counts as the window edge when no whole bar fits between it and the segment.
  const startsAt=candles[0]!.ts-resolutionMs<range.start ? 'window_start' as const : 'data_gap' as const;
  const endsAt=candles.at(-1)!.closeTime+resolutionMs>range.end ? 'window_end' as const : 'data_gap' as const;
  const result=replayTrendCandles({schemaVersion:1,...replay,resolutionMs,candles});
  // A position still open where data is missing has an unknown outcome; its mark is not a result.
  const openAtGap=endsAt==='data_gap' && result.hypotheticalTrades.at(-1)?.exitReason==='end_of_data';
  return {firstOpenMs:candles[0]!.ts,lastCloseMs:candles.at(-1)!.closeTime,candles:candles.length,startsAt,endsAt,openAtGap,result};
 });
 return {...base,outcome:'replayed' as const,reasonCode:null,segments,metrics:windowMetrics(segments)};
}
