import fc from 'fast-check';

import type { MemberId } from '../src/split/types.js';

/** Stable-looking member ids, always unique within a draw. */
export const memberIds = (min = 1, max = 8): fc.Arbitrary<MemberId[]> =>
  fc.uniqueArray(
    fc.integer({ min: 1, max: 9999 }).map((n) => `m${n.toString().padStart(4, '0')}`),
    { minLength: min, maxLength: max },
  );

/** Realistic expense totals: ₹0 to ₹1,00,000 in paise. */
export const amounts = (max = 10_000_000n): fc.Arbitrary<bigint> => fc.bigInt({ min: 0n, max });

export const positiveAmounts = (max = 10_000_000n): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: 1n, max });

export const seeds = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0);

/** Basis points for every member, guaranteed to sum to exactly 10000. */
export const basisPointSplit = (
  members: readonly MemberId[],
): fc.Arbitrary<Record<MemberId, number>> =>
  fc
    .array(fc.integer({ min: 0, max: 100 }), {
      minLength: members.length,
      maxLength: members.length,
    })
    .map((rawWeights) => {
      const total = rawWeights.reduce((sum, weight) => sum + weight, 0);
      const weights = total === 0 ? rawWeights.map(() => 1) : rawWeights;
      const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

      const result: Record<MemberId, number> = {};
      let allocated = 0;
      members.forEach((member, index) => {
        const share = Math.floor((10000 * (weights[index] ?? 0)) / weightTotal);
        result[member] = share;
        allocated += share;
      });
      const first = members[0] as MemberId;
      result[first] = (result[first] ?? 0) + (10000 - allocated);
      return result;
    });

export const weightSplit = (members: readonly MemberId[]): fc.Arbitrary<Record<MemberId, number>> =>
  fc
    .array(fc.integer({ min: 0, max: 20 }), {
      minLength: members.length,
      maxLength: members.length,
    })
    .map((weights) => {
      const result: Record<MemberId, number> = {};
      members.forEach((member, index) => {
        result[member] = weights[index] ?? 0;
      });
      if (members.every((member) => (result[member] ?? 0) === 0)) {
        result[members[0] as MemberId] = 1;
      }
      return result;
    });

/** Exact per-member amounts plus the total they add up to. */
export const exactSplit = (
  members: readonly MemberId[],
): fc.Arbitrary<{ amounts: Record<MemberId, bigint>; total: bigint }> =>
  fc
    .array(fc.bigInt({ min: 0n, max: 500_000n }), {
      minLength: members.length,
      maxLength: members.length,
    })
    .map((values) => {
      const amounts: Record<MemberId, bigint> = {};
      let total = 0n;
      members.forEach((member, index) => {
        const value = values[index] ?? 0n;
        amounts[member] = value;
        total += value;
      });
      return { amounts, total };
    });
