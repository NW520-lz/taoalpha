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
export const trendReplayConfigSchema=z.object({market:z.object({product:z.literal('spot'),quote:z.literal('USDT'),baseQuantity:positive}).strict(),rule:z.object({kind:z.literal('breakout_atr_trailing'),breakoutLookback:window,atrPeriod:window,initialStopAtr:positive,trailingStopAtr:positive}).strict(),cost:z.object({entryFeePpm:ppm,exitFeePpm:ppm,entryImpactPpm:ppm,exitImpactPpm:ppm,funding:z.literal('not_applicable')}).strict()}).strict();
export type TrendReplayConfig=z.infer<typeof trendReplayConfigSchema>;
const schema=trendReplayConfigSchema.extend({schemaVersion:z.literal(1),resolutionMs:z.number().int().min(1).max(86400000),candles:z.array(candle).min(1).max(100000)}).strict();
function invalid():never {throw new DomainError('INVALID_INPUT','Research replay input rejected',[{ruleId:'research.trend_replay_input'}]);}
type Bar={open:Decimal;high:Decimal;low:Decimal;close:Decimal};

/** Simple average of true range over `period` bars ending at `i`; requires i >= period. */
function atr(bars:Bar[],i:number,period:number):Decimal {
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
  let highest=entry, t=i+1, exit:Decimal|null=null, exitReason:'stop'|'gap_through_stop'|'end_of_data'='stop';
  for(;t<bars.length;t++) {
   // Intrabar order is unknown: the stop uses only extremes of completed earlier bars.
   const stop=Decimal.max(initialStop,highest.minus(distance));
   if(bars[t]!.open.lte(stop)){exit=bars[t]!.open;exitReason='gap_through_stop';break;}
   if(bars[t]!.low.lte(stop)){exit=stop;break;}
   highest=Decimal.max(highest,bars[t]!.high);
  }
  if(!exit){t=bars.length-1;exit=bars[t]!.close;exitReason='end_of_data';}
  const buy=qty.times(entry), sell=qty.times(exit);
  const fees=buy.times(cost.entryFeePpm).plus(sell.times(cost.exitFeePpm)).div(1000000);
  const impact=buy.times(cost.entryImpactPpm).plus(sell.times(cost.exitImpactPpm)).div(1000000);
  const gross=sell.minus(buy);
  trades.push({signalIndex:i,entryIndex:i+1,exitIndex:t,exitReason,atrAtSignal:range.toFixed(),initialStopPrice:initialStop.toFixed(),trailingDistance:distance.toFixed(),entryPrice:entry.toFixed(),exitPrice:exit.toFixed(),grossUsdt:gross.toFixed(),feesUsdt:fees.toFixed(),impactUsdt:impact.toFixed(),netUsdt:gross.minus(fees).minus(impact).toFixed()});
  if(exitReason==='end_of_data') break;
  i=t;
 }
 const unit={price:'USDT per base coin',quantity:'base coin',result:'USDT'} as const;
 const assumptions=['entry_at_next_open','stop_uses_prior_completed_bar_extremes','gap_fills_at_open','end_of_data_marked_at_last_close','fees_and_impact_on_notional_once_per_side'];
 return {schemaVersion:1 as const,engineVersion:'breakout-atr-trailing-v1',inputSha256:hashJson(input),status:'insufficient' as const,executionAuthorized:false as const,resultKind:'hypothetical_candles' as const,unit,assumptions,missing:assessHistoricalReadiness().missing,skips,hypotheticalTrades:trades};
}
