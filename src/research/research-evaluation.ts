import {z} from 'zod';
import {DomainError} from '../lib/errors.ts';
import {hashJson} from '../lib/hash.ts';

const positiveInteger=z.string().regex(/^[0-9]{1,80}$/).refine(v=>BigInt(v)>0n);
const timestamp=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ppm=z.number().int().min(0).max(1000000);
const mark=z.object({observedAtMs:timestamp,availableAtMs:timestamp.nullable(),priceMicro:positiveInteger}).strict();
const replaySchema=z.object({schemaVersion:z.literal(1),market:z.object({product:z.literal('spot'),baseQuantityAtoms:positiveInteger,quote:z.literal('USDT')}).strict(),rule:z.object({kind:z.literal('mark_above_reference'),referencePriceMicro:positiveInteger,holdObservations:z.number().int().min(1).max(1000)}).strict(),cost:z.object({entryFeePpm:ppm,exitFeePpm:ppm,entryImpactPpm:ppm,exitImpactPpm:ppm,funding:z.literal('not_applicable')}).strict(),marks:z.array(mark).min(1).max(100000)}).strict();
const unit={price:'USDT per base coin, 10^-6',quantity:'base coin, 10^-8',result:'USDT, 10^-20'} as const;
function invalid():never {throw new DomainError('INVALID_INPUT','Research replay input rejected',[{ruleId:'research.replay_input'}]);}
function plainJson(input:unknown,ancestors=new Set<object>(),depth=0):void {
 if(depth>8) invalid();
 if(input===null || typeof input==='string' || typeof input==='boolean' || typeof input==='number') return;
 if(!input || typeof input!=='object' || ancestors.has(input)) invalid();
 const array=Array.isArray(input), proto=Object.getPrototypeOf(input);
 if(array ? proto!==Array.prototype : proto!==Object.prototype && proto!==null) invalid();
 if(array && (input.length>100000 || Object.keys(input).length!==input.length)) invalid();
 ancestors.add(input);
 for(const key of Reflect.ownKeys(input)) {
  if(array && key==='length') continue;
  if(typeof key!=='string' || key==='__proto__' || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key)>=input.length))) invalid();
  const descriptor=Object.getOwnPropertyDescriptor(input,key);if(!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
  plainJson(descriptor.value,ancestors,depth+1);
 }
 ancestors.delete(input);
}
function value<T>(schema:z.ZodType<T>,input:unknown):T {
 try {plainJson(input);const v=schema.safeParse(input);return v.success?v.data:invalid();} catch {return invalid();}
}

/** Exact integer arithmetic. Fees and impact are separately applied to quote notional. */
function calculate(quantity:string,entry:string,exit:string,entryFee:number,exitFee:number,entryImpact:number,exitImpact:number) {
 const qty=BigInt(quantity), buy=qty*BigInt(entry), sell=qty*BigInt(exit);
 const gross=(sell-buy)*1000000n;
 const fees=buy*BigInt(entryFee)+sell*BigInt(exitFee);
 const impact=buy*BigInt(entryImpact)+sell*BigInt(exitImpact);
 return {grossUsdtE20:String(gross),feesUsdtE20:String(fees),impactUsdtE20:String(impact),netUsdtE20:String(gross-fees-impact)};
}

/**
 * Observed-mark hypothetical replay. It accepts real or synthetic mark series, but
 * timestamps and fills have not been independently authenticated. It never produces
 * an accepted historical result or grants a trading permission.
 */
export function replayObservedMarks(raw:unknown) {
 const input=value(replaySchema,raw);
 let previousAvailable:number|null=null;
 for(let i=0;i<input.marks.length;i++) {
  const m=input.marks[i]!;
  if((i>0 && m.observedAtMs<=input.marks[i-1]!.observedAtMs) || (m.availableAtMs!==null && (m.availableAtMs<m.observedAtMs || (previousAvailable!==null && m.availableAtMs<=previousAvailable)))) invalid();
  if(m.availableAtMs!==null) previousAvailable=m.availableAtMs;
 }
 const missing=['verified_historical_availability','registered_executable_rules','historical_universe','realistic_fill_and_cost_evidence'];
 const trades:Array<{signalIndex:number;entryIndex:number;exitIndex:number;grossUsdtE20:string;feesUsdtE20:string;impactUsdtE20:string;netUsdtE20:string}>=[];
 const skips:string[]=[];
 if(input.marks.some(m=>m.availableAtMs===null)) missing.push('observation_availability_missing');
 else {
  let i=0;
  while(i<input.marks.length) {
   const signal=input.marks[i]!;
   if(BigInt(signal.priceMicro)<=BigInt(input.rule.referencePriceMicro)){i++;continue;}
   // A quote is usable only after the signal is known and only at its own
   // available time. The chosen quote is an assumed fill, not an observed trade.
   let entry=i+1;
   while(entry<input.marks.length && (input.marks[entry]!.observedAtMs<=signal.availableAtMs! || input.marks[entry]!.availableAtMs!==input.marks[entry]!.observedAtMs)) entry++;
   const exit=entry+input.rule.holdObservations;
   if(exit>=input.marks.length || input.marks[exit]!.availableAtMs!==input.marks[exit]!.observedAtMs) {skips.push('no_later_execution_marks');break;}
   trades.push({signalIndex:i,entryIndex:entry,exitIndex:exit,...calculate(input.market.baseQuantityAtoms,input.marks[entry]!.priceMicro,input.marks[exit]!.priceMicro,input.cost.entryFeePpm,input.cost.exitFeePpm,input.cost.entryImpactPpm,input.cost.exitImpactPpm)});
   i=exit+1;
  }
 }
 return {schemaVersion:1 as const,engineVersion:'observed-marks-v1',inputSha256:hashJson(input),status:'insufficient' as const,executionAuthorized:false as const,resultKind:'hypothetical_marks' as const,unit,missing,skips,hypotheticalTrades:trades};
}

const fixtureSchema=z.object({schemaVersion:z.literal(1),provenance:z.literal('synthetic_fixture'),instrument:z.object({product:z.literal('spot'),quote:z.literal('USDT'),quantityUnit:z.literal('base_atoms_1e-8'),priceUnit:z.literal('usdt_micro')}).strict(),rule:z.object({kind:z.literal('close_above_reference'),referencePriceMicro:positiveInteger}).strict(),signal:z.object({closeTimeMs:timestamp,availableAtMs:timestamp,closePriceMicro:positiveInteger}).strict(),entry:z.object({timeMs:timestamp,priceAvailableAtMs:timestamp,priceMicro:positiveInteger}).strict(),exit:z.object({timeMs:timestamp,priceAvailableAtMs:timestamp,priceMicro:positiveInteger}).strict(),quantityBaseAtoms:positiveInteger,cost:z.object({priceIncludesSpreadAndSlippage:z.literal(true),entryFeePpm:ppm,exitFeePpm:ppm,funding:z.literal('not_applicable')}).strict()}).strict();
/** Compatibility helper for isolated synthetic arithmetic checks, never an evaluation gate. */
export function evaluateSyntheticFixture(raw:unknown) {
 const f=value(fixtureSchema,raw);
 if(f.signal.availableAtMs<f.signal.closeTimeMs || f.signal.availableAtMs>=f.entry.timeMs || f.entry.priceAvailableAtMs>f.entry.timeMs || f.exit.priceAvailableAtMs>f.exit.timeMs || f.exit.timeMs<=f.entry.timeMs) invalid();
 if(BigInt(f.signal.closePriceMicro)<=BigInt(f.rule.referencePriceMicro)) return {outcome:'no_signal' as const,netUsdtE20:null,status:'unvalidated' as const,executionAuthorized:false as const};
 const {impactUsdtE20,...amounts}=calculate(f.quantityBaseAtoms,f.entry.priceMicro,f.exit.priceMicro,f.cost.entryFeePpm,f.cost.exitFeePpm,0,0);
 return {outcome:'hypothetical_trade' as const,...amounts,status:'unvalidated' as const,executionAuthorized:false as const};
}

export function assessHistoricalReadiness() {return {status:'insufficient' as const,executionAuthorized:false as const,missing:['verified_historical_availability','registered_executable_rules','historical_universe','realistic_fill_and_cost_evidence']};}
