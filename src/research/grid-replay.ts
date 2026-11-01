import {z} from 'zod';
import {Decimal,dec,isDecimalString} from '../lib/decimal.ts';
import {hashJson} from '../lib/hash.ts';
import {assessHistoricalReadiness,parseReplayInput} from './research-evaluation.ts';
import {contiguousBars,replayCandle,tradeCosts} from './trend-replay.ts';

const positive=z.string().max(64).refine(v=>isDecimalString(v) && dec(v).gt(0));
const ppm=z.number().int().min(0).max(1000000);
const configShape={
 market:z.object({product:z.literal('spot'),quote:z.literal('USDT'),baseQuantity:positive}).strict(),
 rule:z.object({kind:z.literal('grid_spot'),lowerPrice:positive,upperPrice:positive,gridCount:z.number().int().min(1).max(200),spacing:z.enum(['arithmetic','geometric']),stopPrice:positive}).strict(),
 cost:z.object({entryFeePpm:ppm,exitFeePpm:ppm,entryImpactPpm:ppm,exitImpactPpm:ppm,funding:z.literal('not_applicable')}).strict(),
};
const ordered=(v:{rule:{stopPrice:string;lowerPrice:string;upperPrice:string}})=>dec(v.rule.stopPrice).lt(v.rule.lowerPrice) && dec(v.rule.lowerPrice).lt(v.rule.upperPrice);
/** Parameters an experiment registration would freeze; candles and bar size come from the bound history. */
export const gridReplayConfigSchema=z.object(configShape).strict().refine(ordered);
const schema=z.object({schemaVersion:z.literal(1),resolutionMs:z.number().int().min(1).max(86400000),candles:z.array(replayCandle).min(1).max(100000),...configShape}).strict().refine(ordered);

type GridExit='grid_sell'|'stop'|'gap_through_stop'|'end_of_data';

/** Grid lines from lower to upper, inclusive; slot i buys at line i and sells at line i+1. */
export function gridLevels(rule:{lowerPrice:string;upperPrice:string;gridCount:number;spacing:'arithmetic'|'geometric'}):Decimal[] {
 const lower=dec(rule.lowerPrice), upper=dec(rule.upperPrice), n=rule.gridCount;
 return Array.from({length:n+1},(_,i)=>rule.spacing==='arithmetic' ? lower.plus(upper.minus(lower).times(i).div(n)) : lower.times(upper.div(lower).pow(new Decimal(i).div(n))));
}

/**
 * Spot grid on closed candles, starting with no inventory. At each bar an empty slot has a resting buy at
 * its line only if the reference price (previous close, or the first open) is above that line. Intrabar
 * order is unknown, so it is resolved against the strategy: a slot bought in a bar is never sold in the
 * same bar, a slot sold in a bar is not re-bought in it, and fills happen at the line price. A bar whose low
 * reaches the stop is taken to fall first: every resting buy fills, then all inventory exits at the stop (or
 * the open when it gapped below), and the grid ends.
 */
export function replayGridCandles(raw:unknown) {
 const input=parseReplayInput(schema,raw);
 const {rule,cost}=input, qty=dec(input.market.baseQuantity);
 const bars=contiguousBars(input.candles,input.resolutionMs), levels=gridLevels(rule);
 const holding=new Map<number,{entryIndex:number;entry:Decimal}>();
 const trades:Array<ReturnType<typeof settle>>=[];
 const stop=dec(rule.stopPrice);
 let stoppedAt:number|null=null, realized=new Decimal(0), peak=new Decimal(0), drawdown=new Decimal(0), maxInventory=0;
 function settle(slot:number,entryIndex:number,entry:Decimal,exitIndex:number,exit:Decimal,exitReason:GridExit) {
  const {gross,fees,impact}=tradeCosts(qty,entry,exit,cost);
  return {slot,entryIndex,exitIndex,exitReason,entryPrice:entry.toFixed(),exitPrice:exit.toFixed(),grossUsdt:gross.toFixed(),feesUsdt:fees.toFixed(),impactUsdt:impact.toFixed(),fundingUsdt:'0',netUsdt:gross.minus(fees).minus(impact).toFixed()};
 }
 const net=(entry:Decimal,exit:Decimal)=>{const {gross,fees,impact}=tradeCosts(qty,entry,exit,cost);return gross.minus(fees).minus(impact);};
 for(let t=0;t<bars.length;t++) {
  const bar=bars[t]!, reference=t===0 ? bar.open : bars[t-1]!.close;
  const armed=levels.slice(0,-1).flatMap((line,slot)=>!holding.has(slot) && reference.gt(line) ? [slot] : []);
  if(bar.low.lte(stop)) {
   // Worst path: down first, so every resting buy fills, no sell is reached, and everything exits at the stop.
   for(const slot of armed) holding.set(slot,{entryIndex:t,entry:levels[slot]!});
   const [exit,reason]=bar.open.lte(stop) ? [bar.open,'gap_through_stop' as const] : [stop,'stop' as const];
   for(const [slot,position] of holding){const trade=settle(slot,position.entryIndex,position.entry,t,exit,reason);trades.push(trade);realized=realized.plus(trade.netUsdt);}
   maxInventory=Math.max(maxInventory,holding.size); holding.clear(); stoppedAt=t;
   drawdown=Decimal.max(drawdown,peak.minus(realized));
   break;
  }
  for(const [slot,position] of [...holding]) {
   const sellAt=levels[slot+1]!;
   if(bar.high.gte(sellAt)){const trade=settle(slot,position.entryIndex,position.entry,t,sellAt,'grid_sell');trades.push(trade);realized=realized.plus(trade.netUsdt);holding.delete(slot);}
  }
  for(const slot of armed) if(bar.low.lte(levels[slot]!)) holding.set(slot,{entryIndex:t,entry:levels[slot]!});
  maxInventory=Math.max(maxInventory,holding.size);
  // Equity marks open inventory at this close, net of the costs of selling it there.
  let equity=realized;
  for(const position of holding.values()) equity=equity.plus(net(position.entry,bar.close));
  peak=Decimal.max(peak,equity); drawdown=Decimal.max(drawdown,peak.minus(equity));
 }
 const last=bars.length-1;
 for(const [slot,position] of holding) trades.push(settle(slot,position.entryIndex,position.entry,last,bars[last]!.close,'end_of_data'));
 trades.sort((a,b)=>a.exitIndex-b.exitIndex || a.slot-b.slot);
 return {schemaVersion:1 as const,engineVersion:'grid-spot-v1',inputSha256:hashJson(input),status:'insufficient' as const,executionAuthorized:false as const,resultKind:'hypothetical_candles' as const,
  unit:{price:'USDT per base coin',quantity:'base coin per slot',result:'USDT'} as const,levels:levels.map(l=>l.toFixed()),
  assumptions:['starts_without_inventory','buy_rests_only_below_reference_price','no_same_bar_round_trip','fills_at_line_price','stop_bar_assumes_low_before_high','gap_below_stop_fills_at_open','grid_ends_after_stop','end_of_data_marked_at_last_close','equity_drawdown_marked_at_closes_not_intrabar_lows','fees_and_impact_on_notional_once_per_side'],
  missing:assessHistoricalReadiness().missing,stoppedAtIndex:stoppedAt,maxInventorySlots:maxInventory,maxEquityDrawdownUsdt:drawdown.toFixed(),hypotheticalTrades:trades};
}
