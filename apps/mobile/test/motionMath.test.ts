/**
 * The count-up and the stagger, checked as numbers.
 *
 * These are the two ways the motion can be wrong without looking wrong on the
 * screen it runs on: a balance that eases to the wrong figure, or a list whose
 * stagger grows without bound the longer the list is. Both are caught here.
 */

import { describe, expect, it } from 'vitest';

import { easeOutCubic, lerpBig, MAX_SAFE_MINOR, staggerDelay } from '@/lib/motionMath';

describe('easeOutCubic', () => {
  it('pins the ends and eases in between', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    // Ease-out is past halfway at the midpoint — most of the distance early.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('clamps input outside [0, 1] rather than overshooting', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe('lerpBig', () => {
  it('lands exactly on the target at the end, to the paise', () => {
    // The whole point: a count-up must finish on the real number, not near it.
    expect(lerpBig(0n, 45_000n, 1)).toBe(45_000n);
    expect(lerpBig(0n, 45_000n, 0)).toBe(0n);
  });

  it('rounds to the unit part-way through', () => {
    expect(lerpBig(0n, 100n, 0.5)).toBe(50n);
    expect(lerpBig(0n, 3n, 0.5)).toBe(2n); // Math.round(1.5) === 2
  });

  it('counts down as readily as up', () => {
    expect(lerpBig(1000n, 0n, 0.25)).toBe(750n);
  });

  it('snaps to the ends when progress runs past them', () => {
    expect(lerpBig(0n, 500n, 1.5)).toBe(500n);
    expect(lerpBig(0n, 500n, -0.5)).toBe(0n);
  });
});

describe('staggerDelay', () => {
  it('steps the delay up one row at a time', () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(1)).toBe(55);
    expect(staggerDelay(3)).toBe(165);
  });

  it('caps, so a long list still finishes arriving', () => {
    expect(staggerDelay(8)).toBe(440);
    expect(staggerDelay(50)).toBe(440);
    expect(staggerDelay(8)).toBe(staggerDelay(200));
  });

  it('treats a negative index as the first row', () => {
    expect(staggerDelay(-5)).toBe(0);
  });
});

describe('MAX_SAFE_MINOR', () => {
  it('is the Number safe-integer ceiling, as a bigint', () => {
    expect(MAX_SAFE_MINOR).toBe(9_007_199_254_740_991n);
  });
});
