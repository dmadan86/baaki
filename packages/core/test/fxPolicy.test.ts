/**
 * The three tiers a rate can come from (this bill → your rate → the trip rate),
 * and the two things that keep the feature honest:
 *
 *   - the most specific rate that *actually converts the pair* wins, and a rate
 *     for the wrong pair is skipped rather than misapplied;
 *   - a stored rate is labelled by comparison, not by a stamp, so a bill written
 *     at the trip rate stops calling itself that the moment an admin moves the
 *     trip rate — the bill's own number has not changed, only what it matches.
 */

import { describe, expect, it } from 'vitest';

import {
  displayRate,
  fromFxRecord,
  FxTier,
  fxTierOf,
  groupFxRate,
  rateFromDecimal,
  resolveFxRate,
  sameRate,
  toGroupFxEntry,
  type GroupFxRates,
} from '../src/index.js';

const trip = rateFromDecimal('312', 'INR', 'VND', { source: 'manual' }); // 1 ₹ = ₫312
const personal = rateFromDecimal('305', 'INR', 'VND', { source: 'manual' });
const expense = rateFromDecimal('318', 'INR', 'VND', { source: 'manual' });

describe('which rate wins', () => {
  it('takes the most specific tier present', () => {
    expect(resolveFxRate({ trip, personal, expense }, 'INR', 'VND')?.tier).toBe(FxTier.Expense);
    expect(resolveFxRate({ trip, personal }, 'INR', 'VND')?.tier).toBe(FxTier.Personal);
    expect(resolveFxRate({ trip }, 'INR', 'VND')?.tier).toBe(FxTier.Trip);
    expect(resolveFxRate({}, 'INR', 'VND')).toBeNull();
  });

  it('skips a tier whose rate is for a different pair', () => {
    const thbTrip = rateFromDecimal('0.42', 'THB', 'INR');
    // The trip rate is THB→INR; the bill is INR→VND. The trip tier does not
    // apply, so the personal rate wins rather than the wrong-pair trip rate.
    const resolved = resolveFxRate({ trip: thbTrip, personal }, 'INR', 'VND');
    expect(resolved?.tier).toBe(FxTier.Personal);
  });
});

describe('what tier a stored rate reads as, now', () => {
  it('matches the trip rate until the trip rate moves', () => {
    expect(fxTierOf(trip, { trip, personal })).toBe(FxTier.Trip);
    const movedTrip = rateFromDecimal('300', 'INR', 'VND');
    // Same stored bill, admin has since moved the trip rate: the bill is now its
    // own rate, not the trip's.
    expect(fxTierOf(trip, { trip: movedTrip, personal })).toBe(FxTier.Expense);
  });

  it('calls a rate the same when it converts the same', () => {
    const halved = rateFromDecimal('312.00', 'INR', 'VND');
    expect(sameRate(trip, halved)).toBe(true);
    expect(fxTierOf(halved, { trip })).toBe(FxTier.Trip);
  });
});

describe("the group's stored map", () => {
  it('round-trips one pair through the entry shape', () => {
    const rates: GroupFxRates = { INR: toGroupFxEntry(trip) };
    const back = groupFxRate(rates, 'INR', 'VND');
    expect(back).not.toBeNull();
    expect(sameRate(back!, trip)).toBe(true);
    // The `to` is not stored per entry — it is always the group's currency.
    expect(back!.to).toBe('VND');
    expect(back!.from).toBe('INR');
  });

  it('has no rate for an unlisted pair and never throws on junk', () => {
    expect(groupFxRate({ INR: toGroupFxEntry(trip) }, 'THB', 'VND')).toBeNull();
    expect(groupFxRate(null, 'INR', 'VND')).toBeNull();
    expect(groupFxRate({ INR: { num: 'x', den: '0', ts: '', source: '' } }, 'INR', 'VND')).toBeNull();
  });
});

describe('showing the rate the way a person holds it', () => {
  it('turns a sub-1 rate around and says so', () => {
    // 1 VND = 0.0032 INR is useless; 1 ₹ = ₫312 is the same fact, checkable.
    const vndToInr = fromFxRecord({ ...toGroupFxEntry(trip), from: 'VND', to: 'INR' });
    const inverted = rateFromDecimal('0.0032', 'VND', 'INR');
    const shown = displayRate(inverted);
    expect(shown.inverted).toBe(true);
    expect(shown.rate.from).toBe('INR');
    expect(shown.rate.to).toBe('VND');
    void vndToInr;
  });

  it('leaves a rate above 1 alone', () => {
    const shown = displayRate(trip);
    expect(shown.inverted).toBe(false);
    expect(sameRate(shown.rate, trip)).toBe(true);
  });
});
