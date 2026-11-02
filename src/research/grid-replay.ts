import {z} from 'zod';
import {Decimal,dec,isDecimalString} from '../lib/decimal.ts';
import {hashJson} from '../lib/hash.ts';
import {assessHistoricalReadiness,parseReplayInput} from './research-evaluation.ts';
import {contiguousBars,replayCandle,tradeCosts} from './trend-replay.ts';

const positive=z.string().max(64).refine(v=>isDecimalString(v) && dec(v).gt(0));
const fraction=z.string().max(32).refine(v=>isDecimalString(v) && dec(v).gt(0) && dec(v).lt(1));
const ppm=z.number().int().min(0).max(1000000);
// Range and stop are fractions of the price each grid is centred on, so no future price level is assumed.
const configShape={
 market:z.object({product:z.literal('spot'),quote:z.literal('USDT'),baseQuantity:positive}).strict(),
 rule:z.object({kind:z.literal('grid_spot'),rangeFraction:fraction,gridCount:z.number().int().min(1).max(200),spacing:z.enum(['arithmetic','geometric']),stopFraction:fraction}).strict(),
 cost:z.object({entryFeePpm:ppm,exitFeePpm:ppm,entryImpactPpm:ppm,exitImpactPpm:ppm,funding:z.literal('not_applicable')}).strict(),
};
const stopBelowRange=(v:{rule:{rangeFraction:string;stopFraction:string}})=>dec(v.rule.stopFraction).gt(v.rule.rangeFraction);
/** Parameters an experiment registration freezes; candles and bar size come from the bound history. */
export const gridReplayConfigSchema=z.object(configShape).strict().refine(stopBelowRange);
export type GridReplayConfig=z.infer<typeof gridReplayConfigSchema>;
const schema=z.object({schemaVersion:z.literal(1),resolutionMs:z.number().int().min(1).max(86400000),candles:z.array(replayCandle).min(1).max(100000),...configShape}).strict().refine(stopBelowRange);

type GridExit='grid_sell'|'stop'|'gap_through_stop'|'end_of_data';
type Rule=GridReplayConfig['rule'];

/** Lines from centre x (1 - range) to centre x (1 + range); slot i buys at line i and sells at line i+1. */
function gridAround(centre:Decimal,rule:Rule) {
 const lower=centre.times(dec('1').minus(rule.rangeFraction)), upper=centre.times(dec('1').plus(rule.rangeFraction)), n=rule.gridCount;
 const levels=Array.from({length:n+1},(_,i)=>rule.spacing==='arithmetic' ? lower.plus(upper.minus(lower).times(i).div(n)) : lower.times(upper.div(lower).pow(new Decimal(i).div(n))));
 return {centre,levels,stop:centre.times(dec('1').minus(rule.stopFraction))};
}

/**
 * Spot grid on closed candles, starting without inventory. A grid is centred on the reference price (the
 * previous close, or the first open) and re-centred there whenever it holds nothing and that price has left
 * its range, or after a stop. At each bar an empty slot has a resting buy at its line only if the reference
 * price is above that line. Intrabar order is unknown, so it is resolved against the strategy: a slot bought
 * in a bar is never sold in the same bar, a slot sold in a bar is not re-bought in it, and fills happen at the
 * line price. A bar whose low reaches the stop is taken to fall first: every resting buy fills, then all
 * inventory exits at the stop (or the open when it gapped below).
 */
export function replayGridCandles(raw:unknown) {
 const input=parseReplayInput(schema,raw);
 const {rule,cost}=input, qty=dec(input.market.baseQuantity);
 const bars=contiguousBars(input.candles,input.resolutionMs);
 const holding=new Map<number,{entryIndex:number;entry:Decimal}>();
 const trades:Array<ReturnType<typeof settle>>=[], grids:Array<{startIndex:number;centre:string;levels:string[];stopPrice:string}>=[], stops:number[]=[];
 let grid:ReturnType<typeof gridAround>|null=null, realized=new Decimal(0), peak=new Decimal(0), drawdown=new Decimal(0), maxInventory=0;
 function settle(slot:number,entryIndex:number,entry:Decimal,exitIndex:number,exit:Decimal,exitReason:GridExit) {
  const {gross,fees,impact}=tradeCosts(qty,entry,exit,cost);
  return {slot,entryIndex,exitIndex,exitReason,entryPrice:entry.toFixed(),exitPrice:exit.toFixed(),grossUsdt:gross.toFixed(),feesUsdt:fees.toFixed(),impactUsdt:impact.toFixed(),fundingUsdt:'0',netUsdt:gross.minus(fees).minus(impact).toFixed()};
 }
 const exitAll=(t:number,exit:Decimal,reason:GridExit)=>{
  for(const [slot,position] of holding){const trade=settle(slot,position.entryIndex,position.entry,t,exit,reason);trades.push(trade);realized=realized.plus(trade.netUsdt);}
  holding.clear();
 };
 for(let t=0;t<bars.length;t++) {
  const bar=bars[t]!, reference=t===0 ? bar.open : bars[t-1]!.close;
  if(!grid || (!holding.size && (reference.lt(grid.levels[0]!) || reference.gt(grid.levels.at(-1)!)))) {
   grid=gridAround(reference,rule);
   grids.push({startIndex:t,centre:reference.toFixed(),levels:grid.levels.map(l=>l.toFixed()),stopPrice:grid.stop.toFixed()});
  }
  const {levels,stop}=grid;
  const armed=levels.slice(0,-1).flatMap((line,slot)=>!holding.has(slot) && reference.gt(line) ? [slot] : []);
  if(bar.low.lte(stop)) {
   // Worst path: down first, so every resting buy fills, no sell is reached, and everything exits at the stop.
   for(const slot of armed) holding.set(slot,{entryIndex:t,entry:levels[slot]!});
   maxInventory=Math.max(maxInventory,holding.size);
   if(bar.open.lte(stop)) exitAll(t,bar.open,'gap_through_stop'); else exitAll(t,stop,'stop');
   stops.push(t); grid=null;
  } else {
   for(const [slot,position] of [...holding]) {
    const sellAt=levels[slot+1]!;
    if(bar.high.gte(sellAt)){const trade=settle(slot,position.entryIndex,position.entry,t,sellAt,'grid_sell');trades.push(trade);realized=realized.plus(trade.netUsdt);holding.delete(slot);}
   }
   for(const slot of armed) if(bar.low.lte(levels[slot]!)) holding.set(slot,{entryIndex:t,entry:levels[slot]!});
   maxInventory=Math.max(maxInventory,holding.size);
  }
  // Equity marks open inventory at this close, net of the costs of selling it there.
  let equity=realized;
  for(const position of holding.values()){const {gross,fees,impact}=tradeCosts(qty,position.entry,bar.close,cost);equity=equity.plus(gross.minus(fees).minus(impact));}
  peak=Decimal.max(peak,equity); drawdown=Decimal.max(drawdown,peak.minus(equity));
 }
 const last=bars.length-1;
 for(const [slot,position] of holding) trades.push(settle(slot,position.entryIndex,position.entry,last,bars[last]!.close,'end_of_data'));
 trades.sort((a,b)=>a.exitIndex-b.exitIndex || a.slot-b.slot);
 return {schemaVersion:1 as const,engineVersion:'grid-spot-v2',inputSha256:hashJson(input),status:'insufficient' as const,executionAuthorized:false as const,resultKind:'hypothetical_candles' as const,
  unit:{price:'USDT per base coin',quantity:'base coin per slot',result:'USDT'} as const,
  assumptions:['starts_without_inventory','centred_on_reference_price','recentres_when_empty_and_outside_range_or_after_stop','buy_rests_only_below_reference_price','no_same_bar_round_trip','fills_at_line_price','stop_bar_assumes_low_before_high','gap_below_stop_fills_at_open','end_of_data_marked_at_last_close','equity_drawdown_marked_at_closes_not_intrabar_lows','fees_and_impact_on_notional_once_per_side'],
  missing:assessHistoricalReadiness().missing,grids,stops,maxInventorySlots:maxInventory,maxEquityDrawdownUsdt:drawdown.toFixed(),hypotheticalTrades:trades};
}
