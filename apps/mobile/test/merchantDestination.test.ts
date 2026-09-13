/**
 * "Where it went last time" — the claim the Review row makes before a swipe
 * confirms it.
 *
 * A chip that lies is worse than a chip that asks, so the interesting cases
 * here are the ones where the answer is withheld.
 */

import { describe, expect, it } from 'vitest';

import {
  buildMerchantDestinations,
  destinationFor,
  type FiledExpense,
} from '../src/lib/merchantDestination';

function filed(groupId: string, description: string, at: string): FiledExpense {
  return { groupId, description, at };
}

describe('buildMerchantDestinations', () => {
  it('remembers the group a shop’s money went to', () => {
    const map = buildMerchantDestinations([filed('goa', 'Swiggy', '2026-09-01T10:00:00Z')]);
    expect(map.get('swiggy')).toBe('goa');
  });

  it('sees through gateway noise to the same shop', () => {
    const map = buildMerchantDestinations([
      filed('goa', 'POS UPI SWIGGY*ORDER 8842', '2026-09-01T10:00:00Z'),
    ]);
    // The same key `normaliseMerchantName` gives the draft's own description.
    expect([...map.keys()]).toContain('swiggy order');
  });

  it('keeps pointing at the group a shop is used in most, not merely the newest', () => {
    const map = buildMerchantDestinations([
      filed('goa', 'Blue Tokai', '2026-09-01T10:00:00Z'),
      filed('goa', 'Blue Tokai', '2026-09-02T10:00:00Z'),
      filed('flat', 'Blue Tokai', '2026-09-03T10:00:00Z'),
    ]);
    // Newest is `flat` with one, but `goa` has two — no settled home, so silence.
    expect(map.has('blue tokai')).toBe(false);
  });

  it('answers when the newest group is also the busiest', () => {
    const map = buildMerchantDestinations([
      filed('flat', 'Blue Tokai', '2026-09-01T10:00:00Z'),
      filed('goa', 'Blue Tokai', '2026-09-02T10:00:00Z'),
      filed('goa', 'Blue Tokai', '2026-09-03T10:00:00Z'),
    ]);
    expect(map.get('blue tokai')).toBe('goa');
  });

  it('says nothing about a name that is not a name', () => {
    const map = buildMerchantDestinations([
      filed('goa', '', '2026-09-01T10:00:00Z'),
      filed('goa', 'UPI', '2026-09-01T10:00:00Z'),
    ]);
    expect(map.size).toBe(0);
  });
});

describe('destinationFor', () => {
  const merchants = new Map([['swiggy', 'goa']]);
  const assignable = new Set(['goa', 'flat']);

  it('prefers the group a person named when the spend was caught', () => {
    expect(
      destinationFor({ description: 'Swiggy', target_group_id: 'flat' }, merchants, assignable),
    ).toEqual({ groupId: 'flat', reason: 'tagged' });
  });

  it('falls back to where the shop’s money went last time', () => {
    expect(
      destinationFor({ description: 'Swiggy', target_group_id: null }, merchants, assignable),
    ).toEqual({ groupId: 'goa', reason: 'last-time' });
  });

  it('asks rather than points at a group the viewer has left', () => {
    expect(
      destinationFor({ description: 'Swiggy', target_group_id: null }, merchants, new Set()),
    ).toBeNull();
    // A tag pointing somewhere unreachable is not an answer either — and must
    // not shadow the merchant history, which here is also unreachable.
    expect(
      destinationFor({ description: 'Swiggy', target_group_id: 'gone' }, merchants, new Set(['x'])),
    ).toBeNull();
  });

  it('asks when it has never seen this shop', () => {
    expect(
      destinationFor({ description: 'Blue Tokai', target_group_id: null }, merchants, assignable),
    ).toBeNull();
    expect(
      destinationFor({ description: '', target_group_id: null }, merchants, assignable),
    ).toBeNull();
  });
});
