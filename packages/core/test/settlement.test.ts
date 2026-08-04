import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  allocateSettlement,
  buildUpiIntentUri,
  canTransition,
  isValidVpa,
  SettlementError,
  type Receivable,
} from '../src/settlement/apply.js';
import { toMajorString } from '../src/money/money.js';

const formatMajor = (amount: bigint, currency: string): string =>
  toMajorString({ minor: amount, currency });

const receivables: Receivable[] = [
  { expenseId: 'e-old', date: '2026-01-05', amount: 30000n },
  { expenseId: 'e-mid', date: '2026-02-10', amount: 20000n },
  { expenseId: 'e-new', date: '2026-03-20', amount: 50000n },
];

describe('settlement allocation (ADR-007: partial and per-expense are first-class)', () => {
  it('applies unallocated money oldest-expense-first', () => {
    const result = allocateSettlement({ amount: 40000n }, receivables);
    expect(result.allocations).toEqual([
      { expenseId: 'e-mid', amount: 10000n },
      { expenseId: 'e-old', amount: 30000n },
    ]);
    expect(result.unallocated).toBe(0n);
  });

  it('honours explicit per-expense allocations before the oldest-first sweep', () => {
    const result = allocateSettlement(
      { amount: 40000n, allocations: [{ expenseId: 'e-new', amount: 25000n }] },
      receivables,
    );
    const byExpense = Object.fromEntries(
      result.allocations.map((allocation) => [allocation.expenseId, allocation.amount]),
    );
    expect(byExpense['e-new']).toBe(25000n);
    expect(byExpense['e-old']).toBe(15000n);
    expect(result.unallocated).toBe(0n);
  });

  it('reports money that outruns the debt as unallocated (an advance)', () => {
    const result = allocateSettlement({ amount: 200000n }, receivables);
    expect(result.unallocated).toBe(100000n);
  });

  it('never allocates more than the settlement or more than is outstanding', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 200000n }), (amount) => {
        const result = allocateSettlement({ amount }, receivables);
        const allocated = result.allocations.reduce((total, a) => total + a.amount, 0n);
        expect(allocated + result.unallocated).toBe(amount);
        for (const allocation of result.allocations) {
          const outstanding = receivables.find((r) => r.expenseId === allocation.expenseId)?.amount;
          expect(allocation.amount <= (outstanding ?? 0n)).toBe(true);
        }
      }),
    );
  });

  it('rejects allocations against an expense with no debt between the pair', () => {
    expect(() =>
      allocateSettlement(
        { amount: 1000n, allocations: [{ expenseId: 'someone-elses', amount: 1000n }] },
        receivables,
      ),
    ).toThrowError(SettlementError);
  });

  it('rejects allocations bigger than the settlement itself', () => {
    expect(() =>
      allocateSettlement(
        { amount: 1000n, allocations: [{ expenseId: 'e-old', amount: 5000n }] },
        receivables,
      ),
    ).toThrowError(/settlement amount/);
  });
});

describe('UPI intent (ADR-007: Baaki never moves the money)', () => {
  it('builds a standard intent URI', () => {
    const uri = buildUpiIntentUri(
      {
        vpa: 'priya@okaxis',
        payeeName: 'Priya',
        amount: 42000n,
        currency: 'INR',
        note: 'Baaki Goa trip',
      },
      formatMajor,
    );
    expect(uri.startsWith('upi://pay?')).toBe(true);
    expect(uri).toContain('pa=priya%40okaxis');
    expect(uri).toContain('am=420.00');
    expect(uri).toContain('cu=INR');
    expect(uri).toContain('tn=Baaki');
  });

  it('validates VPAs', () => {
    expect(isValidVpa('priya@okaxis')).toBe(true);
    expect(isValidVpa('9876543210@ybl')).toBe(true);
    expect(isValidVpa('not-a-vpa')).toBe(false);
    expect(() =>
      buildUpiIntentUri({ vpa: 'nope', payeeName: 'X', amount: 1n, currency: 'INR' }, formatMajor),
    ).toThrowError(SettlementError);
  });
});

describe('settlement state machine', () => {
  it('allows confirm, dispute, cancel and auto-confirm from initiated', () => {
    expect(canTransition('initiated', 'confirm')).toBe(true);
    expect(canTransition('initiated', 'auto_confirm')).toBe(true);
  });

  it('is terminal once confirmed or cancelled, but auto-confirmed can be disputed', () => {
    expect(canTransition('confirmed', 'cancel')).toBe(false);
    expect(canTransition('cancelled', 'confirm')).toBe(false);
    expect(canTransition('auto_confirmed', 'dispute')).toBe(true);
  });
});
