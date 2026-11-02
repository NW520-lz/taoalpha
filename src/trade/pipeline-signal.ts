import { Decimal } from '../lib/decimal.ts';
import { atr } from '../research/trend-replay.ts';

/** Registered strategy version for the demo end-to-end check (option B, 2026-11-02). It carries no trading thesis. */
export const PIPELINE_STRATEGY = {
 id: 'pipeline-test', version: 1,
 entryRules: 'demo pipeline check only, not a trading strategy: one spot long of the smallest size the card allows, on request',
 exitRules: 'initial stop entry - 2 x ATR(14) and trailing stop frozen at 3 x ATR(14) on closed 4H candles, as on the card',
 invalidationRules: 'stop hit, card rejected, or any reconciliation block',
} as const;

type Candle = { ts: number; closeTime: number; open: string; high: string; low: string; close: string; confirmed: boolean };

/** A pipeline-check signal on the latest closed 4H candle, or null with fewer than 15 closed candles. */
export function pipelineSignal(input: { instId: string; candles: Candle[]; evidenceRef: string }) {
 const closed = input.candles.filter(c => c.confirmed).sort((a, b) => a.ts - b.ts);
 if (closed.length < 15) return null;
 const bars = closed.map(c => ({ open: new Decimal(c.open), high: new Decimal(c.high), low: new Decimal(c.low), close: new Decimal(c.close) }));
 const last = closed.length - 1;
 return { instId: input.instId, product: 'spot' as const, direction: 'long' as const, signalCloseAt: new Date(closed[last]!.closeTime).toISOString(),
  atrUsdt: atr(bars, last, 14).toFixed(), initialStopAtr: '2', trailingStopAtr: '3', evidenceRefs: [input.evidenceRef] };
}
