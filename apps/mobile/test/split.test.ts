import { describe, expect, it } from 'vitest';

import { computeShares } from '@baaki/core';

import {
  entryValues,
  fillEntries,
  formatEntry,
  parseEntry,
  SplitKind,
  splitProblem,
} from '../src/lib/split';

describe('parseEntry', () => {
  it('reads whole shares', () => {
    expect(parseEntry('shares', '3')).toBe(3);
    expect(parseEntry('shares', ' 12 ')).toBe(12);
  });

  it('refuses a fractional share rather than rounding it', () => {
    expect(parseEntry('shares', '1.5')).toBeNull();
    expect(parseEntry('shares', '-1')).toBeNull();
    expect(parseEntry('shares', 'two')).toBeNull();
  });

  it('reads percentages as basis points', () => {
    expect(parseEntry('percent', '25')).toBe(2500);
    expect(parseEntry('percent', '33.33')).toBe(3333);
    expect(parseEntry('percent', '33.3')).toBe(3330);
    expect(parseEntry('percent', '100')).toBe(10000);
  });

  it('converts in decimal, not in floating point', () => {
    // 0.29 * 10000 is 2899.9999999999995 — one paisa off, silently.
    expect(parseEntry('percent', '0.29')).toBe(29);
    expect(parseEntry('percent', '8.11')).toBe(811);
  });

  it('refuses a third decimal place and anything over 100', () => {
    expect(parseEntry('percent', '33.333')).toBeNull();
    expect(parseEntry('percent', '101')).toBeNull();
  });

  it('treats a field nobody has typed in yet as zero, not as an error', () => {
    expect(parseEntry('percent', '')).toBe(0);
    expect(parseEntry('percent', '.')).toBe(0);
    expect(parseEntry('shares', '')).toBe(0);
  });
});

describe('formatEntry', () => {
  it('round-trips a percentage back into the field it came from', () => {
    for (const text of ['25', '33.33', '33.3', '0.29', '100', '12.05']) {
      expect(formatEntry('percent', parseEntry('percent', text) ?? -1)).toBe(text);
    }
  });
});

describe('splitProblem', () => {
  const people = ['a', 'b', 'c'];

  it('says nothing about an equal split', () => {
    expect(splitProblem(SplitKind.Equal, {}, people)).toBeNull();
  });

  it('accepts shares with at least one positive weight', () => {
    expect(splitProblem(SplitKind.Shares, { a: '2', b: '1', c: '0' }, people)).toBeNull();
  });

  it('refuses shares that are all zero', () => {
    expect(splitProblem(SplitKind.Shares, { a: '0', b: '0', c: '0' }, people)).toMatch(/at least one/);
  });

  it('says how much percentage is left, and how much is too much', () => {
    expect(splitProblem(SplitKind.Percent, { a: '30', b: '30', c: '30' }, people)).toBe(
      'That is 90% — 10% left to give out.',
    );
    expect(splitProblem(SplitKind.Percent, { a: '50', b: '30', c: '30' }, people)).toBe(
      'That is 110% — 10% too much.',
    );
  });

  it('accepts percentages that sum to exactly 100', () => {
    expect(splitProblem(SplitKind.Percent, { a: '33.34', b: '33.33', c: '33.33' }, people)).toBeNull();
  });

  it('ignores members who are not in the split', () => {
    expect(splitProblem(SplitKind.Percent, { a: '50', b: '50', c: '80' }, ['a', 'b'])).toBeNull();
  });
});

describe('fillEntries', () => {
  const people = ['a', 'b', 'c'];

  it('opens a fresh percent split on something valid', () => {
    const filled = fillEntries('percent', {}, people);
    expect(splitProblem(SplitKind.Percent, filled ?? {}, people)).toBeNull();
  });

  it('starts somebody added later at zero rather than rewriting the others', () => {
    const filled = fillEntries('percent', { a: '60', b: '40' }, people);
    expect(filled).toEqual({ a: '60', b: '40', c: '0' });
  });

  it('gives a new member of a shares split one share', () => {
    expect(fillEntries('shares', { a: '2' }, people)).toEqual({ a: '2', b: '1', c: '1' });
  });

  it('returns null when there is nothing to fill, so render does not loop', () => {
    expect(fillEntries('shares', { a: '1', b: '1', c: '1' }, people)).toBeNull();
  });
});

describe('what the screen hands to the money engine', () => {
  const people = ['a', 'b', 'c'];

  it('splits by weight', () => {
    const shares = computeShares({
      amount: 6000n,
      currency: 'INR',
      params: {
        kind: 'shares',
        weights: entryValues('shares', { a: '3', b: '2', c: '1' }, people),
      },
      participants: people,
      seed: 'expense-1',
    });
    expect(shares.get('a')).toBe(3000n);
    expect(shares.get('b')).toBe(2000n);
    expect(shares.get('c')).toBe(1000n);
  });

  it('splits by percentage without losing a paisa', () => {
    const entries = fillEntries('percent', {}, people) ?? {};
    const shares = computeShares({
      amount: 10000n,
      currency: 'INR',
      params: { kind: 'percent', basisPoints: entryValues('percent', entries, people) },
      participants: people,
      seed: 'expense-1',
    });
    expect([...shares.values()].reduce((sum, share) => sum + share, 0n)).toBe(10000n);
  });

  it('never reaches the engine while the problem message is showing', () => {
    const entries = { a: '30', b: '30', c: '30' };
    expect(splitProblem(SplitKind.Percent, entries, people)).not.toBeNull();
    expect(() =>
      computeShares({
        amount: 10000n,
        currency: 'INR',
        params: { kind: 'percent', basisPoints: entryValues('percent', entries, people) },
        participants: people,
        seed: 'expense-1',
      }),
    ).toThrow();
  });
});
