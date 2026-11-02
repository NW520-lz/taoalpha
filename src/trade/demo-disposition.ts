import { dec } from '../risk/risk-decimal.ts';

type Submission = 'accepted' | 'rejected' | 'unknown' | null;
export type DispositionAction = 'lookup_entry' | 'release_not_placed' | 'place_protection' | 'lookup_stop_history' | 'cancel_remaining_entry' | 'exit_intent_exposure';
export interface IntentFacts {
 entrySubmission: Submission;
 /** Result of looking the entry up by client order id, when it was looked up. */
 entryLookup: 'found' | 'not_found' | null;
 /** Exchange state of the entry order when known (live, partially_filled, filled, canceled). */
 entryState: string | null;
 /** Base quantity this intent holds after fees, from reconciled fills. */
 filledHeldQty: string;
 initialStop: { submission: Submission; exchangeState: string };
}

/**
 * The card's approved exception handling (I-07, I-17) for one intent, as next actions. It never resends an entry:
 * an unknown entry is looked up; only a rejection or the exchange's "not found" releases it. Holdings without a
 * live initial stop lock new risk; a stop that was placed but is no longer live is looked up first, because a
 * triggered stop is not a missing one. Exits only ever touch this intent's own holdings. Pure.
 */
export function planDisposition(f: IntentFacts): { actions: DispositionAction[]; lockNewRisk: boolean } {
 if (f.entrySubmission === 'rejected' || f.entryLookup === 'not_found') return { actions: ['release_not_placed'], lockNewRisk: false };
 if (f.entrySubmission === 'unknown' && f.entryLookup === null) return { actions: ['lookup_entry'], lockNewRisk: true };
 if (!dec(f.filledHeldQty).gt(0)) return { actions: [], lockNewRisk: false };
 if (f.initialStop.exchangeState === 'live') return { actions: [], lockNewRisk: false };
 if (f.initialStop.submission === null) return { actions: ['place_protection'], lockNewRisk: true };
 if (f.initialStop.submission === 'accepted') return { actions: ['lookup_stop_history'], lockNewRisk: true };
 const stillBuying = f.entryState === 'live' || f.entryState === 'partially_filled';
 return { actions: [...(stillBuying ? ['cancel_remaining_entry' as const] : []), 'exit_intent_exposure'], lockNewRisk: true };
}
