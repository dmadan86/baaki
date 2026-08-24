/**
 * Travel presets are builders over the canonical split params — so the one
 * property that matters is that whatever they return, fed through the audited
 * computeShares, still sums exactly to the bill and lands the money where the
 * preset intends. These tests pin both.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { computeShares, sumShares } from '../src/split/computeShares';
import { carRentalSplit, ridersSplit, splitByUnits, treatSplit } from '../src/split/travel';
import { SplitError } from '../src/split/types';

const seed = 'expense-1';

describe('splitByUnits (nights / presence)', () => {
  it('divides in proportion to the counts', () => {
    // Five-night hotel, ₹5,000: two stayed 5 nights, one stayed 2.
    const params = splitByUnits({ ravi: 5, asha: 5, neha: 2 });
    const shares = computeShares({
      amount: 6000n,
      currency: 'INR',
      params,
      participants: ['ravi', 'asha', 'neha'],
      seed,
    });
    expect(sumShares(shares)).toBe(6000n);
    // 12 night-units → 500/unit; ravi & asha 2500, neha 1000.
    expect(shares.get('ravi')).toBe(2500n);
    expect(shares.get('asha')).toBe(2500n);
    expect(shares.get('neha')).toBe(1000n);
  });

  it('refuses a split where nobody stayed a night', () => {
    expect(() => splitByUnits({ ravi: 0, asha: 0 })).toThrow(SplitError);
    expect(() => splitByUnits({ ravi: 1.5 })).toThrow(SplitError);
  });

  it('always sums to the total for any counts and amount', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd'), fc.integer({ min: 0, max: 9 }), {
          minKeys: 1,
        }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        (units, amount) => {
          const hasPositive = Object.values(units).some((u) => u > 0);
          if (!hasPositive) return; // guarded by NoPositiveWeight, tested above
          const params = splitByUnits(units);
          const shares = computeShares({
            amount,
            currency: 'INR',
            params,
            participants: Object.keys(units),
            seed,
          });
          expect(sumShares(shares)).toBe(amount);
        },
      ),
    );
  });
});

describe('carRentalSplit', () => {
  it('splits the base equally and adds fuel on top, excusing the driver', () => {
    // ₹4,000 total: ₹1,000 fuel (asha), ₹3,000 base across the two non-drivers.
    const { params, participants } = carRentalSplit({
      participants: ['ravi', 'asha', 'driver'],
      extrasByMember: { asha: 1000n },
      exemptDriver: 'driver',
    });
    const shares = computeShares({
      amount: 4000n,
      currency: 'INR',
      params,
      participants,
      seed,
    });
    expect(sumShares(shares)).toBe(4000n);
    expect(shares.get('driver')).toBeUndefined(); // excused entirely
    // base 3000 split two ways = 1500 each; asha carries +1000 fuel.
    expect(shares.get('ravi')).toBe(1500n);
    expect(shares.get('asha')).toBe(2500n);
  });

  it('refuses a fuel extra for the excused driver', () => {
    expect(() =>
      carRentalSplit({
        participants: ['ravi', 'driver'],
        extrasByMember: { driver: 500n },
        exemptDriver: 'driver',
      }),
    ).toThrow(SplitError);
  });
});

describe('ridersSplit (this ride only)', () => {
  it('splits equally across just the riders', () => {
    const { params, participants } = ridersSplit(['ravi', 'asha', 'neha', 'neha']);
    expect(participants).toEqual(['ravi', 'asha', 'neha']); // deduped
    const shares = computeShares({ amount: 900n, currency: 'INR', params, participants, seed });
    expect(sumShares(shares)).toBe(900n);
    expect([...shares.values()].every((s) => s === 300n)).toBe(true);
  });
});

describe('treatSplit (my treat)', () => {
  it('puts the whole bill on the host and zero on the guests', () => {
    const params = treatSplit({
      host: 'ravi',
      participants: ['ravi', 'asha', 'neha'],
      amountMinor: 4200n,
    });
    const shares = computeShares({
      amount: 4200n,
      currency: 'INR',
      params,
      participants: ['ravi', 'asha', 'neha'],
      seed,
    });
    expect(sumShares(shares)).toBe(4200n);
    expect(shares.get('ravi')).toBe(4200n);
    expect(shares.get('asha')).toBe(0n); // shows in history, owes nothing
    expect(shares.get('neha')).toBe(0n);
  });

  it('requires the host to be one of the participants', () => {
    expect(() =>
      treatSplit({ host: 'outsider', participants: ['ravi', 'asha'], amountMinor: 100n }),
    ).toThrow(SplitError);
  });
});
