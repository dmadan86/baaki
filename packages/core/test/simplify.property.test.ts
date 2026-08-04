/**
 * ADR-009: simplification is a suggestion layer. It may never change what
 * anyone actually owes in net terms.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { NetBalances } from '../src/balances/types.js';
import { simplify } from '../src/simplify/simplify.js';
import type { MemberId } from '../src/split/types.js';
import { memberIds } from './arbitraries.js';

const INR = 'INR';

/** Balances that already sum to zero, as any real group's do. */
const zeroSumBalances = memberIds(2, 8).chain((members) =>
  fc
    .array(fc.bigInt({ min: -500_000n, max: 500_000n }), {
      minLength: members.length - 1,
      maxLength: members.length - 1,
    })
    .map((values) => {
      const perCurrency = new Map<MemberId, bigint>();
      let running = 0n;
      members.slice(0, -1).forEach((member, index) => {
        const value = values[index] ?? 0n;
        perCurrency.set(member, value);
        running += value;
      });
      perCurrency.set(members[members.length - 1] as MemberId, -running);
      const balances: NetBalances = new Map([[INR, perCurrency]]);
      return { members, balances };
    }),
);

describe('simplify', () => {
  it('preserves every member’s net position', () => {
    fc.assert(
      fc.property(zeroSumBalances, ({ members, balances }) => {
        const transfers = simplify(balances);
        const after = new Map<MemberId, bigint>();
        for (const member of members) after.set(member, 0n);
        for (const transfer of transfers) {
          after.set(transfer.from, (after.get(transfer.from) ?? 0n) - transfer.amount);
          after.set(transfer.to, (after.get(transfer.to) ?? 0n) + transfer.amount);
        }
        for (const member of members) {
          expect(after.get(member)).toBe(balances.get(INR)?.get(member) ?? 0n);
        }
      }),
    );
  });

  it('never proposes more than n−1 transfers', () => {
    fc.assert(
      fc.property(zeroSumBalances, ({ members, balances }) => {
        expect(simplify(balances).length).toBeLessThanOrEqual(members.length - 1);
      }),
    );
  });

  it('only proposes positive transfers between two different people', () => {
    fc.assert(
      fc.property(zeroSumBalances, ({ balances }) => {
        for (const transfer of simplify(balances)) {
          expect(transfer.amount > 0n).toBe(true);
          expect(transfer.from).not.toBe(transfer.to);
        }
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(zeroSumBalances, ({ balances }) => {
        expect(simplify(balances)).toEqual(simplify(balances));
      }),
    );
  });

  it('collapses a circular debt into nothing', () => {
    // a owes b 100, b owes c 100, c owes a 100 → everyone is square.
    const balances: NetBalances = new Map([[INR, new Map([['a', 0n], ['b', 0n], ['c', 0n]])]]);
    expect(simplify(balances)).toEqual([]);
  });

  it('turns a chain into a single payment', () => {
    // a owes 100, b is square, c is owed 100.
    const balances: NetBalances = new Map([
      [INR, new Map([['a', -10000n], ['b', 0n], ['c', 10000n]])],
    ]);
    expect(simplify(balances)).toEqual([
      { from: 'a', to: 'c', currency: INR, amount: 10000n },
    ]);
  });
});
