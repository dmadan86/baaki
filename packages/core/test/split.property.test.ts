/**
 * ADR-014 property tests for the split engine.
 * The headline invariant: Σ shares === amount, for every split type, always.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { computeShares, sumShares } from '../src/split/computeShares.js';
import { SplitError, type MemberId } from '../src/split/types.js';
import {
  amounts,
  basisPointSplit,
  exactSplit,
  memberIds,
  seeds,
  weightSplit,
} from './arbitraries.js';

const INR = 'INR';

describe('computeShares — Σ shares === amount', () => {
  it('holds for equal splits', () => {
    fc.assert(
      fc.property(memberIds(), amounts(), seeds(), (members, amount, seed) => {
        const shares = computeShares({
          amount,
          currency: INR,
          params: { kind: 'equal' },
          participants: members,
          seed,
        });
        expect(sumShares(shares)).toBe(amount);
        expect(shares.size).toBe(members.length);
      }),
    );
  });

  it('holds for exact splits', () => {
    fc.assert(
      fc.property(
        memberIds().chain((members) => exactSplit(members).map((split) => ({ members, split }))),
        seeds(),
        ({ members, split }, seed) => {
          const shares = computeShares({
            amount: split.total,
            currency: INR,
            params: { kind: 'exact', amounts: split.amounts },
            participants: members,
            seed,
          });
          expect(sumShares(shares)).toBe(split.total);
        },
      ),
    );
  });

  it('holds for percentage splits', () => {
    fc.assert(
      fc.property(
        memberIds().chain((members) =>
          basisPointSplit(members).map((basisPoints) => ({ members, basisPoints })),
        ),
        amounts(),
        seeds(),
        ({ members, basisPoints }, amount, seed) => {
          const shares = computeShares({
            amount,
            currency: INR,
            params: { kind: 'percent', basisPoints },
            participants: members,
            seed,
          });
          expect(sumShares(shares)).toBe(amount);
        },
      ),
    );
  });

  it('holds for weighted (shares) splits', () => {
    fc.assert(
      fc.property(
        memberIds().chain((members) =>
          weightSplit(members).map((weights) => ({ members, weights })),
        ),
        amounts(),
        seeds(),
        ({ members, weights }, amount, seed) => {
          const shares = computeShares({
            amount,
            currency: INR,
            params: { kind: 'shares', weights },
            participants: members,
            seed,
          });
          expect(sumShares(shares)).toBe(amount);
        },
      ),
    );
  });

  it('holds for adjustment splits', () => {
    fc.assert(
      fc.property(
        memberIds().chain((members) =>
          fc
            .array(fc.bigInt({ min: -50_000n, max: 50_000n }), {
              minLength: members.length,
              maxLength: members.length,
            })
            .map((values) => {
              const adjustments: Record<MemberId, bigint> = {};
              members.forEach((member, index) => {
                adjustments[member] = values[index] ?? 0n;
              });
              return { members, adjustments };
            }),
        ),
        amounts(),
        seeds(),
        ({ members, adjustments }, amount, seed) => {
          const shares = computeShares({
            amount,
            currency: INR,
            params: { kind: 'adjustment', adjustments },
            participants: members,
            seed,
          });
          expect(sumShares(shares)).toBe(amount);
        },
      ),
    );
  });

  it('holds for itemized splits including prorated tax and tip', () => {
    fc.assert(
      fc.property(
        memberIds(1, 6).chain((members) =>
          fc
            .record({
              lines: fc.array(
                fc.record({
                  total: fc.bigInt({ min: 0n, max: 200_000n }),
                  claimerCount: fc.integer({ min: 1, max: members.length }),
                  claimerOffset: fc.integer({ min: 0, max: members.length - 1 }),
                }),
                { minLength: 1, maxLength: 8 },
              ),
              taxes: fc.bigInt({ min: 0n, max: 30_000n }),
              serviceCharge: fc.bigInt({ min: 0n, max: 20_000n }),
              tip: fc.bigInt({ min: 0n, max: 20_000n }),
            })
            .map((draw) => ({ members, ...draw })),
        ),
        seeds(),
        ({ members, lines, taxes, serviceCharge, tip }, seed) => {
          const items = lines.map((line) => ({ total: line.total }));
          const claims: Record<number, MemberId[]> = {};
          lines.forEach((line, index) => {
            const claimers: MemberId[] = [];
            for (let step = 0; step < line.claimerCount; step += 1) {
              claimers.push(members[(line.claimerOffset + step) % members.length] as MemberId);
            }
            claims[index] = [...new Set(claimers)];
          });
          const itemsTotal = items.reduce((total, item) => total + item.total, 0n);
          const amount = itemsTotal + taxes + serviceCharge + tip;

          const shares = computeShares({
            amount,
            currency: INR,
            params: { kind: 'itemized', items, claims, taxes, serviceCharge, tip },
            participants: members,
            seed,
          });
          expect(sumShares(shares)).toBe(amount);
        },
      ),
    );
  });
});

describe('computeShares — determinism and fairness', () => {
  it('is deterministic: identical input yields identical output', () => {
    fc.assert(
      fc.property(memberIds(), amounts(), seeds(), (members, amount, seed) => {
        const once = computeShares({
          amount,
          currency: INR,
          params: { kind: 'equal' },
          participants: members,
          seed,
        });
        // Participants shuffled: order must not matter, only the stable sort does.
        const twice = computeShares({
          amount,
          currency: INR,
          params: { kind: 'equal' },
          participants: [...members].reverse(),
          seed,
        });
        expect([...twice.entries()].sort()).toEqual([...once.entries()].sort());
      }),
    );
  });

  it('rotates the leftover paisa across expenses instead of always charging the same member', () => {
    const members = ['m1', 'm2', 'm3'];
    const absorbers = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      const shares = computeShares({
        amount: 100n, // 100 / 3 = 33 remainder 1
        currency: INR,
        params: { kind: 'equal' },
        participants: members,
        seed: `expense-${index}`,
      });
      for (const [member, share] of shares) {
        if (share === 34n) absorbers.add(member);
      }
    }
    expect(absorbers.size).toBeGreaterThan(1);
  });

  it('never gives a paisa to a member with a zero weight', () => {
    const shares = computeShares({
      amount: 101n,
      currency: INR,
      params: { kind: 'shares', weights: { a: 1, b: 1, c: 0 } },
      participants: ['a', 'b', 'c'],
      seed: 'zero-weight',
    });
    expect(shares.get('c')).toBe(0n);
    expect(sumShares(shares)).toBe(101n);
  });
});

describe('computeShares — rejections', () => {
  it('rejects exact shares that do not add up', () => {
    expect(() =>
      computeShares({
        amount: 1000n,
        currency: INR,
        params: { kind: 'exact', amounts: { a: 400n, b: 400n } },
        participants: ['a', 'b'],
        seed: 'x',
      }),
    ).toThrowError(SplitError);
  });

  it('rejects percentages that do not sum to 100%', () => {
    expect(() =>
      computeShares({
        amount: 1000n,
        currency: INR,
        params: { kind: 'percent', basisPoints: { a: 5000, b: 4000 } },
        participants: ['a', 'b'],
        seed: 'x',
      }),
    ).toThrowError(/10000/);
  });

  it('blocks finalization while a line item is unclaimed (ADR-008)', () => {
    expect(() =>
      computeShares({
        amount: 500n,
        currency: INR,
        params: { kind: 'itemized', items: [{ total: 500n }], claims: {} },
        participants: ['a', 'b'],
        seed: 'x',
      }),
    ).toThrowError(/unclaimed/i);
  });

  it('rejects an itemized bill whose parts do not reconcile with the total', () => {
    expect(() =>
      computeShares({
        amount: 999n,
        currency: INR,
        params: { kind: 'itemized', items: [{ total: 500n }], claims: { 0: ['a'] }, taxes: 100n },
        participants: ['a', 'b'],
        seed: 'x',
      }),
    ).toThrowError(/total/i);
  });

  it('rejects unknown members and empty participant lists', () => {
    expect(() =>
      computeShares({
        amount: 100n,
        currency: INR,
        params: { kind: 'exact', amounts: { ghost: 100n } },
        participants: ['a'],
        seed: 'x',
      }),
    ).toThrowError(/not a participant/i);

    expect(() =>
      computeShares({
        amount: 100n,
        currency: INR,
        params: { kind: 'equal' },
        participants: [],
        seed: 'x',
      }),
    ).toThrowError(/at least one participant/i);
  });
});

describe('computeShares — worked examples', () => {
  it('splits ₹100 three ways as 33.34 / 33.33 / 33.33', () => {
    const shares = computeShares({
      amount: 10000n,
      currency: INR,
      params: { kind: 'equal' },
      participants: ['a', 'b', 'c'],
      seed: 'dinner',
    });
    const values = [...shares.values()].sort();
    expect(values).toEqual([3333n, 3333n, 3334n]);
  });

  it('prorates tax by item subtotal, not equally', () => {
    // Asha's ₹300 biryani, Ravi's ₹100 roti, ₹40 tax → tax splits 30/10.
    const shares = computeShares({
      amount: 44000n,
      currency: INR,
      params: {
        kind: 'itemized',
        items: [{ total: 30000n }, { total: 10000n }],
        claims: { 0: ['asha'], 1: ['ravi'] },
        taxes: 4000n,
      },
      participants: ['asha', 'ravi'],
      seed: 'biryani',
    });
    expect(shares.get('asha')).toBe(33000n);
    expect(shares.get('ravi')).toBe(11000n);
  });
});
