/**
 * The id that makes a second import a no-op.
 *
 * `expenses.client_mutation_id` is UNIQUE, so whatever this returns is what
 * actually decides whether a re-import writes a second expense. Two things
 * have to hold: it must be shaped like a UUID, or the insert fails on a
 * column type rather than doing anything useful; and it must be the same
 * every time for the same input, or the uniqueness buys nothing.
 */

import { describe, expect, it } from 'vitest';

import { uuidFromDigest } from '@/lib/uuid8';

const A_DIGEST = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

describe('shaping a digest as a UUID', () => {
  it('produces something Postgres will take as a uuid', () => {
    expect(uuidFromDigest(A_DIGEST)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('marks it version 8 — a custom id, which is what it is', () => {
    // Not v4: nothing here is random. Not v5: that would have to be SHA-1 over
    // a namespace to deserve the name.
    expect(uuidFromDigest(A_DIGEST)[14]).toBe('8');
  });

  it('sets the variant bits', () => {
    expect('89ab').toContain(uuidFromDigest(A_DIGEST)[19]);
  });

  it('gives the same answer every time', () => {
    expect(uuidFromDigest(A_DIGEST)).toBe(uuidFromDigest(A_DIGEST));
  });

  it('gives different answers to different digests', () => {
    const other = 'a'.repeat(64);
    expect(uuidFromDigest(other)).not.toBe(uuidFromDigest(A_DIGEST));
  });

  it('ignores case and formatting the platform might add', () => {
    expect(uuidFromDigest(A_DIGEST.toUpperCase())).toBe(uuidFromDigest(A_DIGEST));
  });

  it('refuses a digest too short to fill a UUID', () => {
    // Silently padding would make two different inputs collide.
    expect(() => uuidFromDigest('abc')).toThrow(/too short/);
  });
});
