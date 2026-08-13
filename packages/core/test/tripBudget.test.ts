/**
 * Trip budgets: what a member spent is the sum of their shares, and a cap is
 * measured only against spend in its own currency. These tests pin the two
 * places the maths could quietly lie — mixing currencies into one bar, and
 * confusing "no budget" with "a budget of zero".
 */

import { describe, expect, it } from 'vitest';

import { budgetProgress, spendByMember, type SharedExpense } from '../src/trip/budget';

const expenses: SharedExpense[] = [
  { currency: 'INR', shares: { alice: 2000n, bob: 1000n } },
  { currency: 'INR', shares: { alice: 500n } },
  { currency: 'EUR', shares: { alice: 4000n, bob: 4000n } },
];

describe('spendByMember', () => {
  it('sums each member’s shares per currency', () => {
    const spend = spendByMember(expenses);
    expect(spend.get('alice')).toEqual({ INR: 2500n, EUR: 4000n });
    expect(spend.get('bob')).toEqual({ INR: 1000n, EUR: 4000n });
  });

  it('never invents a zero for a member with no share', () => {
    const spend = spendByMember([{ currency: 'INR', shares: { alice: 0n, bob: 500n } }]);
    expect(spend.has('alice')).toBe(false);
    expect(spend.get('bob')).toEqual({ INR: 500n });
  });
});

describe('budgetProgress', () => {
  const spend = spendByMember(expenses);

  it('measures a cap only against its own currency', () => {
    const p = budgetProgress({ amountMinor: 5000n, currency: 'INR' }, spend.get('alice'));
    // Alice's EUR spend must not touch a rupee cap.
    expect(p).toMatchObject({ spentMinor: 2500n, remainingMinor: 2500n, over: false, ratio: 0.5 });
  });

  it('flags over-budget and keeps the overflow off the bar', () => {
    const p = budgetProgress({ amountMinor: 2000n, currency: 'INR' }, spend.get('alice'));
    expect(p?.over).toBe(true);
    expect(p?.ratio).toBe(1); // bar is full, not 1.25
    expect(p?.remainingMinor).toBe(-500n); // the honest gap is signed
  });

  it('returns null for no budget, but a real bar for a zero cap', () => {
    expect(budgetProgress(null, spend.get('alice'))).toBeNull();
    const zero = budgetProgress({ amountMinor: 0n, currency: 'INR' }, spend.get('alice'));
    expect(zero).toMatchObject({ capMinor: 0n, over: true, ratio: 1 });
  });

  it('treats spend in a currency nobody budgeted as zero against the cap', () => {
    const p = budgetProgress({ amountMinor: 1000n, currency: 'USD' }, spend.get('alice'));
    expect(p).toMatchObject({ spentMinor: 0n, ratio: 0, over: false });
  });
});
