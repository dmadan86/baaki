/**
 * Experiment bucketing.
 *
 * The properties here are the ones an experiment's credibility rests on: the
 * same person always lands in the same place, the split is actually even, and
 * widening a rollout never moves somebody who was already in it. A bucketer
 * that fails any of those produces results that look fine and mean nothing.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BUCKET_FIXTURES, bucketOf, isEnabled, variantFor, type FeatureFlag } from '../src/index';

const flag = (over: Partial<FeatureFlag> = {}): FeatureFlag => ({
  key: 'itemized_receipts',
  enabled: true,
  rolloutPercent: 100,
  variants: ['control', 'treatment'],
  ...over,
});

const uuid = fc.uuid();

describe('the hash both languages have to agree on', () => {
  it('matches the recorded fixtures', () => {
    // These same numbers are asserted against the plpgsql in
    // packages/db/test/featureFlags.test.ts. If one side drifts, one fails.
    for (const { input, bucket } of BUCKET_FIXTURES) {
      expect(bucketOf(input), JSON.stringify(input)).toBe(bucket);
    }
  });

  it('always lands in 0–99', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const bucket = bucketOf(input);
        expect(Number.isInteger(bucket)).toBe(true);
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThan(100);
      }),
      { numRuns: 500 },
    );
  });

  it('gives the same answer every time', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(bucketOf(input)).toBe(bucketOf(input));
      }),
    );
  });

  it('spreads a population across the range', () => {
    // Not a uniformity proof — a smoke test that the hash is not degenerate.
    // A bucketer that answered 7 for everybody would pass every test above.
    const seen = new Set<number>();
    for (let index = 0; index < 2000; index += 1) {
      seen.add(bucketOf(`itemized_receipts:user-${index}`));
    }
    expect(seen.size).toBeGreaterThan(90);
  });
});

describe('who is in the experiment', () => {
  it('gives one person the same variant forever', () => {
    fc.assert(
      fc.property(uuid, (profileId) => {
        const first = variantFor(flag(), profileId);
        expect(variantFor(flag(), profileId)).toBe(first);
      }),
    );
  });

  it('says nothing at all when the flag is off', () => {
    fc.assert(
      fc.property(uuid, (profileId) => {
        expect(variantFor(flag({ enabled: false }), profileId)).toBeNull();
        expect(isEnabled(flag({ enabled: false }), profileId)).toBe(false);
      }),
    );
  });

  it('excludes everybody at 0% and nobody at 100%', () => {
    fc.assert(
      fc.property(uuid, (profileId) => {
        expect(variantFor(flag({ rolloutPercent: 0 }), profileId)).toBeNull();
        expect(variantFor(flag({ rolloutPercent: 100 }), profileId)).not.toBeNull();
      }),
    );
  });

  it('never drops somebody when the rollout widens', () => {
    // The property that makes a staged rollout safe. If widening could move a
    // person out, somebody would watch a feature they had been using vanish.
    const people = Array.from({ length: 400 }, (_, index) => `person-${index}`);
    for (let percent = 0; percent < 100; percent += 10) {
      const narrow = people.filter((id) => isEnabled(flag({ rolloutPercent: percent }), id));
      const wide = people.filter((id) => isEnabled(flag({ rolloutPercent: percent + 10 }), id));
      for (const person of narrow) {
        expect(wide, `${person} fell out between ${percent}% and ${percent + 10}%`).toContain(
          person,
        );
      }
    }
  });

  it('does not change somebody’s variant when the rollout widens', () => {
    // Why rollout and variant are hashed from different strings. Sharing one
    // bucket would hand every newly-included person the same variant, so the
    // split inside the new cohort would be 100/0 while the total looked even.
    const people = Array.from({ length: 400 }, (_, index) => `person-${index}`);
    for (const person of people) {
      const at30 = variantFor(flag({ rolloutPercent: 30 }), person);
      const at90 = variantFor(flag({ rolloutPercent: 90 }), person);
      if (at30 !== null) expect(at90).toBe(at30);
    }
  });

  it('splits a population roughly evenly between two variants', () => {
    const people = Array.from({ length: 4000 }, (_, index) => `person-${index}`);
    const counts = new Map<string, number>();
    for (const person of people) {
      const variant = variantFor(flag(), person);
      if (variant) counts.set(variant, (counts.get(variant) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['control', 'treatment']);
    for (const count of counts.values()) {
      // 50% ± 5 points. Wide enough not to be flaky, tight enough to catch a
      // bucketer that leans.
      expect(count).toBeGreaterThan(people.length * 0.45);
      expect(count).toBeLessThan(people.length * 0.55);
    }
  });

  it('handles three variants without favouring one', () => {
    const people = Array.from({ length: 3000 }, (_, index) => `person-${index}`);
    const counts = new Map<string, number>();
    for (const person of people) {
      const variant = variantFor(flag({ variants: ['a', 'b', 'c'] }), person);
      if (variant) counts.set(variant, (counts.get(variant) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['a', 'b', 'c']);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(people.length * 0.28);
    }
  });

  it('refuses a flag with fewer than two variants', () => {
    // An experiment with one arm is a flag pretending to be a test.
    expect(variantFor(flag({ variants: ['only'] }), 'anybody')).toBeNull();
  });
});
