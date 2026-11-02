import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDisposition } from '../../src/trade/demo-disposition.ts';

const base = { entrySubmission: 'accepted', entryLookup: null, entryState: 'filled', filledHeldQty: '0.2325', initialStop: { submission: 'accepted', exchangeState: 'live' } } as const;
const plan = (over: Record<string, unknown> = {}) => planDisposition({ ...base, ...over } as never);

test('a filled entry with its stop live needs nothing', () => {
 assert.deepEqual(plan(), { actions: [], lockNewRisk: false });
});

test('an unknown entry is looked up, never resent; an entry the exchange does not know is released', () => {
 assert.deepEqual(plan({ entrySubmission: 'unknown', entryState: null }), { actions: ['lookup_entry'], lockNewRisk: true });
 assert.deepEqual(plan({ entrySubmission: 'unknown', entryLookup: 'not_found', entryState: null }), { actions: ['release_not_placed'], lockNewRisk: false });
 assert.deepEqual(plan({ entrySubmission: 'rejected', entryState: null }), { actions: ['release_not_placed'], lockNewRisk: false });
});

test('fills without a live initial stop lock new risk, cancel the rest of the entry and exit only this intent', () => {
 assert.deepEqual(plan({ initialStop: { submission: 'rejected', exchangeState: 'not_open' } }), { actions: ['exit_intent_exposure'], lockNewRisk: true });
 assert.deepEqual(plan({ entryState: 'partially_filled', initialStop: { submission: 'unknown', exchangeState: 'not_open' } }), { actions: ['cancel_remaining_entry', 'exit_intent_exposure'], lockNewRisk: true });
 // Not yet placed after a fill: place protection first, holding new risk meanwhile.
 assert.deepEqual(plan({ initialStop: { submission: null, exchangeState: 'not_open' } }), { actions: ['place_protection'], lockNewRisk: true });
 // An accepted stop that is no longer live may have triggered; that is not proof of a missing stop, so look it up.
 assert.deepEqual(plan({ initialStop: { submission: 'accepted', exchangeState: 'not_open' } }), { actions: ['lookup_stop_history'], lockNewRisk: true });
});

test('an accepted entry with no fill yet and nothing to protect waits', () => {
 assert.deepEqual(plan({ entryState: 'live', filledHeldQty: '0', initialStop: { submission: null, exchangeState: 'not_open' } }), { actions: [], lockNewRisk: false });
});
