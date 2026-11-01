import {z} from 'zod';
import {Decimal,dec,isDecimalString} from '../lib/decimal.ts';
import {DomainError} from '../lib/errors.ts';
import {hashJson} from '../lib/hash.ts';
import {assessHistoricalReadiness,parseReplayInput} from './research-evaluation.ts';

const positive=z.string().max(64).refine(v=>isDecimalString(v) && dec(v).gt(0));
const timestamp=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ppm=z.number().int().min(0).max(1000000);
const window=z.number().int().min(1).max(1000);
const nonNegative=z.string().max(64).refine(v=>isDecimalString(v) && dec(v).gte(0));
// Same shape as history manifest candles (src/market/history.ts); volume is carried but unused here.
const volume=z.object({vol:nonNegative,volCcy:nonNegative,volCcyQuote:nonNegative,units:z.object({vol:z.enum(['base','contracts']),volCcy:z.enum(['quote','base']),volCcyQuote:z.literal('quote')}).strict()}).strict();
const candle=z.object({ts:timestamp,closeTime:timestamp,open:positive,high:positive,low:positive,close:positive,volume:volume.optional()}).strict();
/** Parameters an experiment registration freezes; candles and bar size come from the bound history. */
export const trendReplayConfigSchema=z.object({market:z.object({product:z.enum(['spot','usdt_perpetual']),quote:z.literal('USDT'),baseQuantity:positive}).strict(),rule:z.object({kind:z.literal('breakout_atr_trailing'),breakoutLookback:window,atrPeriod:window,initialStopAtr:positive,trailingStopAtr:positive}).strict(),cost:z.object({entryFeePpm:ppm,exitFeePpm:ppm,entryImpactPpm:ppm,exitImpactPpm:ppm,funding:z.enum(['not_applicable','realized_events'])}).strict(),
 // Cross-sectional selection for universe replays; ignored by the single-instrument replay.
 selection:z.object({strengthLookback:window,volumeLookback:window,volumeMultiplier:positive,maxPositions:z.number().int().min(1).max(50)}).strict().optional()}).strict();
export type TrendReplayConfig=z.infer<typeof trendReplayConfigSchema>;
/** Spot has no funding; a perpetual long settles realized public funding events. */
export const fundingMatchesProduct=(c:TrendReplayConfig)=>(c.market.product==='spot')===(c.cost.funding==='not_applicable');
const fundingEvent=z.object({fundingTime:timestamp,realizedRate:z.string().max(32).refine(isDecimalString)}).strict();
const schema=trendReplayConfigSchema.extend({schemaVersion:z.literal(1),resolutionMs:z.number().int().min(1).max(86400000),candles:z.array(candle).min(1).max(100000),fundingEvents:z.array(fundingEvent).max(100000).optional()}).strict()
 .refine(v=>fundingMatchesProduct(v) && (v.fundingEvents!==undefined)===(v.market.product==='usdt_perpetual'));
function invalid():never {throw new DomainError('INVALID_INPUT','Research replay input rejected',[{ruleId:'research.trend_replay_input'}]);}
export type Bar={open:Decimal;high:Decimal;low:Decimal;close:Decimal};
export type ExitReason='stop'|'gap_through_stop'|'end_of_data';

/**
 * One held bar against the trailing stop. Intrabar order is unknown, so the stop uses only extremes of
 * completed earlier bars (`highest`); the caller raises `highest` with this bar's high when it holds.
 */
export function checkStop(bar:Bar,initialStop:Decimal,highest:Decimal,distance:Decimal):{price:Decimal;reason:ExitReason}|null {
 const stop=Decimal.max(initialStop,highest.minus(distance));
 if(bar.open.lte(stop)) return {price:bar.open,reason:'gap_through_stop'};
 if(bar.low.lte(stop)) return {price:stop,reason:'stop'};
 return null;
}

/** Gross, fees and impact of one long round trip; fees and impact apply to each side's notional once. */
export function tradeCosts(qty:Decimal,entry:Decimal,exit:Decimal,cost:{entryFeePpm:number;exitFeePpm:number;entryImpactPpm:number;exitImpactPpm:number}) {
 const buy=qty.times(entry), sell=qty.times(exit);
 return {gross:sell.minus(buy),fees:buy.times(cost.entryFeePpm).plus(sell.times(cost.exitFeePpm)).div(1000000),impact:buy.times(cost.entryImpactPpm).plus(sell.times(cost.exitImpactPpm)).div(1000000)};
}
type FundingEvent=z.infer<typeof fundingEvent>;

/**
 * Long funding over settlements strictly inside (fromTs, toTs), each on the quantity's notional at the
 * close of the last candle completed by that settlement. Positive is paid, negative received.
 */
export function fundingCost(qty:Decimal,candles:Array<{closeTime:number;close:string}>,events:FundingEvent[],fromTs:number,toTs:number):Decimal {
 let funding=new Decimal(0);
 for(const e of events) if(e.fundingTime>fromTs && e.fundingTime<toTs) {
  const marked=candles.findLast(c=>c.closeTime<=e.fundingTime)!;
  funding=funding.plus(qty.times(marked.close).times(e.realizedRate));
 }
 return funding;
}

/** Simple average of true range over `period` bars ending at `i`; requires i >= period. */
export function atr(bars:Bar[],i:number,period:number):Decimal {
 let sum=new Decimal(0);
 for(let j=i-period+1;j<=i;j++) {
  const b=bars[j]!, prevClose=bars[j-1]!.close;
  sum=sum.plus(Decimal.max(b.high.minus(b.low),b.high.minus(prevClose).abs(),b.low.minus(prevClose).abs()));
 }
 return sum.div(period);
}

export function replayTrendCandles(raw:unknown) {
 const input=parseReplayInput(schema,raw);
 const {rule,cost}=input;
 const qty=dec(input.market.baseQuantity);
 const bars:Bar[]=input.candles.map((c,i)=>{
  // Candles must be contiguous closed bars; gaps are split by the caller, never bridged here.
  if(c.closeTime!==c.ts+input.resolutionMs || (i>0 && c.ts!==input.candles[i-1]!.ts+input.resolutionMs)) invalid();
  const b={open:dec(c.open),high:dec(c.high),low:dec(c.low),close:dec(c.close)};
  if(b.low.gt(Decimal.min(b.open,b.close)) || b.high.lt(Decimal.max(b.open,b.close))) invalid();
  return b;
 });
 const trades=[], skips:Array<{signalIndex:number;reason:'no_entry_candle'}>=[];
 let i=Math.max(rule.breakoutLookback,rule.atrPeriod);
 while(i<bars.length) {
  let priorHigh=bars[i-1]!.high;
  for(let j=i-rule.breakoutLookback;j<i;j++) priorHigh=Decimal.max(priorHigh,bars[j]!.high);
  if(!bars[i]!.close.gt(priorHigh)){i++;continue;}
  if(i+1>=bars.length){skips.push({signalIndex:i,reason:'no_entry_candle'});break;}
  const range=atr(bars,i,rule.atrPeriod);
  const entry=bars[i+1]!.open, initialStop=entry.minus(range.times(rule.initialStopAtr)), distance=range.times(rule.trailingStopAtr);
  let highest=entry, t=i+1, exit:Decimal|null=null, exitReason:ExitReason='stop';
  for(;t<bars.length;t++) {
   const hit=checkStop(bars[t]!,initialStop,highest,distance);
   if(hit){exit=hit.price;exitReason=hit.reason;break;}
   highest=Decimal.max(highest,bars[t]!.high);
  }
  if(!exit){t=bars.length-1;exit=bars[t]!.close;exitReason='end_of_data';}
  const {gross,fees,impact}=tradeCosts(qty,entry,exit,cost);
  // Settlements strictly after the entry open and before the exit instant (bar close when the stop time is unknown).
  const entryTs=input.candles[i+1]!.ts, exitTs=exitReason==='gap_through_stop' ? input.candles[t]!.ts : input.candles[t]!.closeTime;
  const funding=fundingCost(qty,input.candles,input.fundingEvents ?? [],entryTs,exitTs);
  trades.push({signalIndex:i,entryIndex:i+1,exitIndex:t,exitReason,atrAtSignal:range.toFixed(),initialStopPrice:initialStop.toFixed(),trailingDistance:distance.toFixed(),entryPrice:entry.toFixed(),exitPrice:exit.toFixed(),grossUsdt:gross.toFixed(),feesUsdt:fees.toFixed(),impactUsdt:impact.toFixed(),fundingUsdt:funding.toFixed(),netUsdt:gross.minus(fees).minus(impact).minus(funding).toFixed()});
  if(exitReason==='end_of_data') break;
  i=t;
 }
 const unit={price:'USDT per base coin',quantity:'base coin',result:'USDT'} as const;
 const perpetual=input.market.product==='usdt_perpetual';
 const assumptions=['entry_at_next_open','stop_uses_prior_completed_bar_extremes','gap_fills_at_open','end_of_data_marked_at_last_close','fees_and_impact_on_notional_once_per_side',...(perpetual ? ['funding_on_prior_close_notional_until_exit_bar_close','quantity_in_base_coin_not_contracts'] : [])];
 // Public funding history is short and has no verified cadence, so coverage is never claimed complete.
 const missing=[...assessHistoricalReadiness().missing,...(perpetual ? ['funding_coverage_unknown'] : [])];
 return {schemaVersion:1 as const,engineVersion:'breakout-atr-trailing-v1',inputSha256:hashJson(input),status:'insufficient' as const,executionAuthorized:false as const,resultKind:'hypothetical_candles' as const,unit,assumptions,missing,skips,hypotheticalTrades:trades};
}
