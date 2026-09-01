import { describe, expect, it } from 'vitest';

import { computeShares } from '@waves/core';

import {
  entryValues,
  exactRemainder,
  exactValues,
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

  it('rejects share weights too large for the input field contract', () => {
    expect(parseEntry('shares', '999999999')).toBe(999999999);
    expect(parseEntry('shares', '1000000000')).toBeNull();
  });

  it('reads percentages as basis points', () => {
    expect(parseEntry('percent', '25')).toBe(2500);
    expect(parseEntry('percent', '33.33')).toBe(3333);
    expect(parseEntry('percent', '33.3')).toBe(3330);
    expect(parseEntry('percent', '100')).toBe(10000);
    expect(parseEntry('percent', '.5')).toBe(50);
  });

  it('converts in decimal, not in floating point', () => {
    // 0.29 * 10000 is 2899.9999999999995 — one paisa off, silently.
    expect(parseEntry('percent', '0.29')).toBe(29);
    expect(parseEntry('percent', '8.11')).toBe(811);
  });

  it('refuses a third decimal place, trailing decimal ambiguity, negatives and anything over 100', () => {
    expect(parseEntry('percent', '33.333')).toBeNull();
    expect(parseEntry('percent', '33.')).toBeNull();
    expect(parseEntry('percent', '-1')).toBeNull();
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
    expect(splitProblem(SplitKind.Shares, { a: '0', b: '0', c: '0' }, people)).toMatch(
      /at least one/,
    );
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
    expect(
      splitProblem(SplitKind.Percent, { a: '33.34', b: '33.33', c: '33.33' }, people),
    ).toBeNull();
  });

  it('ignores members who are not in the split', () => {
    expect(splitProblem(SplitKind.Percent, { a: '50', b: '50', c: '80' }, ['a', 'b'])).toBeNull();
  });

  it('treats an empty participant list as not ready, not broken', () => {
    expect(splitProblem(SplitKind.Shares, { outsider: 'abc' }, [])).toBeNull();
    expect(splitProblem(SplitKind.Percent, { outsider: '150' }, [])).toBeNull();
  });

  it('maps invalid participant fields to zero only after splitProblem has flagged them', () => {
    expect(splitProblem(SplitKind.Shares, { a: 'abc', b: '2' }, ['a', 'b'])).toBe(
      'Shares must be whole numbers.',
    );
    expect(entryValues('shares', { a: 'abc', b: '2' }, ['a', 'b'])).toEqual({ a: 0, b: 2 });
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

  it('returns null for a fresh percent split with nobody selected', () => {
    expect(fillEntries('percent', {}, [])).toBeNull();
  });

  it('fills a large fresh percent split once and still sums to exactly 100%', () => {
    const many = Array.from({ length: 128 }, (_, index) => `m${index}`);
    const filled = fillEntries('percent', {}, many);

    expect(filled).not.toBeNull();
    expect(splitProblem(SplitKind.Percent, filled ?? {}, many)).toBeNull();
    expect(
      Object.values(entryValues('percent', filled ?? {}, many)).reduce((a, b) => a + b, 0),
    ).toBe(10000);
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

  it('handles a large shares split without dropping participants or minor units', () => {
    const many = Array.from({ length: 256 }, (_, index) => `m${index}`);
    const entries = Object.fromEntries(many.map((id, index) => [id, String((index % 5) + 1)]));
    const shares = computeShares({
      amount: 123456789n,
      currency: 'INR',
      params: { kind: 'shares', weights: entryValues('shares', entries, many) },
      participants: many,
      seed: 'large-expense',
    });

    expect(shares.size).toBe(many.length);
    expect([...shares.values()].reduce((sum, share) => sum + share, 0n)).toBe(123456789n);
  });
});

describe('an exact split', () => {
  const people = ['a', 'b', 'c'];

  it('reads each field as money in the expense currency', () => {
    expect(exactValues({ a: '12.50', b: '7', c: '' }, people, 'INR')).toEqual({
      a: 1250n,
      b: 700n,
      c: 0n,
    });
  });

  it('reads a currency with no minor unit as whole units', () => {
    expect(exactValues({ a: '1200', b: '800', c: '0' }, people, 'JPY')).toEqual({
      a: 1200n,
      b: 800n,
      c: 0n,
    });
  });

  it('leaves out anybody who is not in the split', () => {
    // `d` was ticked off after their figure was typed; the text is kept on the
    // screen but must not reach the engine, which rejects a non-participant.
    expect(exactValues({ a: '10', b: '10', c: '10', d: '99' }, people, 'INR')).toEqual({
      a: 1000n,
      b: 1000n,
      c: 1000n,
    });
  });

  it('says what is left to hand out, and what is over', () => {
    expect(exactRemainder({ a: '10', b: '10', c: '10' }, people, 'INR', 3000n)).toBe(0n);
    expect(exactRemainder({ a: '10', b: '10', c: '' }, people, 'INR', 3000n)).toBe(1000n);
    expect(exactRemainder({ a: '10', b: '10', c: '20' }, people, 'INR', 3000n)).toBe(-1000n);
  });

  it('agrees with the engine: a remainder of zero is a split that computes', () => {
    const entries = { a: '12.50', b: '7.25', c: '10.25' };
    expect(exactRemainder(entries, people, 'INR', 3000n)).toBe(0n);

    const shares = computeShares({
      amount: 3000n,
      currency: 'INR',
      params: { kind: 'exact', amounts: exactValues(entries, people, 'INR') },
      participants: people,
      seed: 'expense-1',
    });
    expect(shares.get('a')).toBe(1250n);
    expect(shares.get('b')).toBe(725n);
    expect(shares.get('c')).toBe(1025n);
  });

  it('agrees with the engine the other way too: a remainder is a refusal', () => {
    // The message under the field and the server's EXACT_SUM_MISMATCH are the
    // same rule; this is what stops the two ever drifting apart.
    const entries = { a: '10', b: '10', c: '5' };
    expect(exactRemainder(entries, people, 'INR', 3000n)).not.toBe(0n);
    expect(() =>
      computeShares({
        amount: 3000n,
        currency: 'INR',
        params: { kind: 'exact', amounts: exactValues(entries, people, 'INR') },
        participants: people,
        seed: 'expense-1',
      }),
    ).toThrow();
  });

  it('has no opinion of its own in splitProblem — money is judged elsewhere', () => {
    expect(splitProblem(SplitKind.Exact, { a: '1' }, people)).toBeNull();
  });
});
