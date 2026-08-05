/**
 * ADR-008: the model proposes, the human confirms — and the arithmetic decides
 * what the human is asked to look at.
 *
 * A receipt carries its own checksum: the lines and charges must add up to the
 * printed total. These tests pin what happens when they don't, because that is
 * the case where a plausible wrong number would otherwise reach the ledger.
 */

import { describe, expect, it } from 'vitest';

import { checkReceipt, toItemizedParams } from '../src/receipt/reconcile.js';
import { LOW_CONFIDENCE, type ParsedReceipt } from '../src/receipt/types.js';
import { computeShares } from '../src/split/computeShares.js';
import { SplitError, type SplitErrorCode } from '../src/split/types.js';

/** The code is the contract a client branches on; the prose is not. */
function expectSplitError(run: () => unknown, code: SplitErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SplitError);
    expect((error as SplitError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a ${code} error, but the split succeeded`);
}

const receipt = (overrides: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
  merchant: 'Anjappar',
  date: '2026-03-01',
  currency: 'INR',
  items: [
    { label: 'Biryani', qty: 1, unitPrice: 32000, total: 32000, confidence: 0.98 },
    { label: 'Roti', qty: 2, unitPrice: 4500, total: 9000, confidence: 0.95 },
  ],
  subtotal: 41000,
  taxes: [{ label: 'GST 5%', amount: 2050 }],
  serviceCharge: null,
  tip: null,
  discounts: [],
  grandTotal: 43050,
  ...overrides,
});

describe('a receipt that adds up', () => {
  it('reconciles and asks for nothing', () => {
    const check = checkReceipt(receipt());
    expect(check.reconciles).toBe(true);
    expect(check.difference).toBe(0);
    expect(check.problems).toHaveLength(0);
    expect(check.needsReview).toHaveLength(0);
  });

  it("tolerates a single paisa of the printer's own rounding", () => {
    const check = checkReceipt(receipt({ grandTotal: 43051 }));
    expect(check.reconciles).toBe(true);
    expect(check.difference).toBe(1);
  });

  it('counts service, tip and discounts into the total', () => {
    const check = checkReceipt(
      receipt({
        serviceCharge: 4100,
        tip: 2000,
        discounts: [{ label: 'Loyalty', amount: 1000 }],
        grandTotal: 43050 + 4100 + 2000 - 1000,
      }),
    );
    expect(check.reconciles).toBe(true);
    expect(check.extras).toBe(2050 + 4100 + 2000 - 1000);
  });
});

describe('a receipt that does not add up', () => {
  it('refuses to reconcile and says by how much', () => {
    // A dropped digit: 32000 read as 3200.
    const check = checkReceipt(
      receipt({
        items: [
          { label: 'Biryani', qty: 1, unitPrice: 3200, total: 3200, confidence: 0.6 },
          { label: 'Roti', qty: 2, unitPrice: 4500, total: 9000, confidence: 0.95 },
        ],
      }),
    );

    expect(check.reconciles).toBe(false);
    expect(check.difference).toBe(28800);
    expect(check.problems.some((problem) => problem.kind === 'does_not_reconcile')).toBe(true);
  });

  it('points at the lines the model was least sure of', () => {
    const check = checkReceipt(
      receipt({
        items: [
          { label: 'Biryani', qty: 1, unitPrice: 3200, total: 3200, confidence: 0.4 },
          { label: 'Roti', qty: 2, unitPrice: 4500, total: 9000, confidence: 0.99 },
        ],
      }),
    );
    // When the total is wrong we cannot know which line is at fault, so the
    // least-confident one is where a person should start.
    expect(check.needsReview).toContain(0);
  });
});

describe('lines a person should check', () => {
  it('flags anything the model was unsure about, even when the total is right', () => {
    const check = checkReceipt(
      receipt({
        items: [
          {
            label: 'Biryani',
            qty: 1,
            unitPrice: 32000,
            total: 32000,
            confidence: LOW_CONFIDENCE - 0.01,
          },
          { label: 'Roti', qty: 2, unitPrice: 4500, total: 9000, confidence: 0.95 },
        ],
      }),
    );
    expect(check.reconciles).toBe(true);
    expect(check.needsReview).toEqual([0]);
    expect(check.problems[0]?.kind).toBe('low_confidence');
  });

  it('flags a negative line, which is usually a discount printed as an item', () => {
    const check = checkReceipt(
      receipt({
        items: [
          { label: 'Biryani', qty: 1, unitPrice: 32000, total: 32000, confidence: 0.98 },
          { label: 'Coupon', qty: 1, unitPrice: -5000, total: -5000, confidence: 0.9 },
        ],
        grandTotal: 32000 - 5000 + 2050,
      }),
    );
    expect(check.problems.some((problem) => problem.kind === 'negative_line')).toBe(true);
  });

  it('says so when there are no items at all', () => {
    const check = checkReceipt(receipt({ items: [], grandTotal: 0, taxes: [] }));
    expect(check.problems.some((problem) => problem.kind === 'no_items')).toBe(true);
  });
});

describe('turning a receipt into an expense', () => {
  it('splits the bill by who claimed what, prorating tax by subtotal', () => {
    const scanned = receipt();
    const { amount, params } = toItemizedParams(scanned, { 0: ['asha'], 1: ['asha', 'ravi'] });

    const shares = computeShares({
      amount,
      currency: 'INR',
      params,
      participants: ['asha', 'ravi'],
      seed: 'receipt-1',
    });

    // The printed total is what gets split — nothing is invented or lost.
    expect([...shares.values()].reduce((sum, share) => sum + share, 0n)).toBe(43050n);
    // Asha had the biryani and half the roti, so she owes more.
    expect(shares.get('asha')).toBeGreaterThan(shares.get('ravi') as bigint);
  });

  it('uses the printed total, not the sum of what we parsed', () => {
    // If these ever diverge the split must fail loudly rather than quietly
    // splitting a number that was never on the receipt.
    const scanned = receipt({ grandTotal: 50000 });
    const { amount, params } = toItemizedParams(scanned, { 0: ['asha'], 1: ['asha'] });

    expect(amount).toBe(50000n);
    expectSplitError(
      () =>
        computeShares({
          amount,
          currency: 'INR',
          params,
          participants: ['asha'],
          seed: 'receipt-2',
        }),
      'ITEMIZED_TOTAL_MISMATCH',
    );
  });

  it('will not produce an expense from a receipt with an unclaimed line', () => {
    const scanned = receipt();
    const { amount, params } = toItemizedParams(scanned, { 0: ['asha'] });

    expectSplitError(
      () =>
        computeShares({
          amount,
          currency: 'INR',
          params,
          participants: ['asha', 'ravi'],
          seed: 'receipt-3',
        }),
      'UNCLAIMED_ITEM',
    );
  });
});
