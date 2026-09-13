/**
 * Who the app thinks you are, in the second before it knows.
 *
 * This is a four-line function with one job, and it exists because the obvious
 * spelling of that job — `member.profile_id === profile?.id` — is wrong in a
 * way that reads as correct and that nothing else catches.
 *
 * A ghost is a member with no `profile_id`. An unloaded profile is `undefined`,
 * passed down as `null`. So for the first second of every cold start, the plain
 * comparison says the first ghost in each group is you, and the dashboard
 * computes its balances from that member's point of view — producing the exact
 * negation of the truth, rendered with total confidence: the opposite sign, in
 * the opposite colour, under the opposite word, with every group row agreeing.
 * It was reported as "the amount changes to blue". It was a −₹82,001 that
 * should have been a +₹112,807.
 *
 * The tests below are all one assertion in different clothes: **no viewer, no
 * match**. They are cheap, and the thing they guard is not.
 */

import { describe, expect, it } from 'vitest';

import { isViewer } from '@/data/types';

const me = { profile_id: 'profile-me' };
const someoneElse = { profile_id: 'profile-them' };
/** A ghost: a real member of a real group who has no account. */
const ghost = { profile_id: null };

describe('when the app knows who you are', () => {
  it('finds you', () => {
    expect(isViewer(me, 'profile-me')).toBe(true);
  });

  it('does not find somebody else', () => {
    expect(isViewer(someoneElse, 'profile-me')).toBe(false);
  });

  it('does not find a ghost', () => {
    expect(isViewer(ghost, 'profile-me')).toBe(false);
  });
});

describe('when it does not', () => {
  // The whole point. Every one of these is the first second of a cold start.
  for (const nothing of [null, undefined, ''] as const) {
    it(`matches no ghost (${JSON.stringify(nothing)})`, () => {
      expect(isViewer(ghost, nothing)).toBe(false);
    });

    it(`matches no real member either (${JSON.stringify(nothing)})`, () => {
      expect(isViewer(me, nothing)).toBe(false);
    });
  }

  it('finds nobody at all in a group full of ghosts', () => {
    // The shape that produced the wrong balance: a group of ghosts, a profile
    // that has not arrived, and a `.find` that used to return the first row.
    const members = [ghost, { profile_id: null }, me];
    expect(members.find((member) => isViewer(member, null))).toBeUndefined();
    // And for contrast, the spelling this function exists to replace:
    expect(members.find((member) => member.profile_id === null)).toBe(ghost);
  });
});
