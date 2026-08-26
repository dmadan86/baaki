/**
 * `serialiseExpense` is the whole serialisation surface of `useWriteExpense`: it
 * turns an expense write into the JSON envelope the `/sync` queue stores and
 * replays. Every field the `sync` edge reads back off that envelope
 * (`buildApplyExpenseArgs` in `@waves/core`, and the `payload.*` reads in
 * `supabase/functions/sync`) must be produced here, or an offline write silently
 * loses it relative to the direct `expense-write` path.
 *
 * The regression this pins: the envelope used to drop `baseVersionNo`, so an
 * offline *edit* skipped the concurrent-edit conflict check (TDR §4.4) that the
 * direct path had; `receiptId`/`receiptShareUrl` were the same latent hole.
 *
 * Tested here (not through `data/hooks.ts`) on purpose: importing hooks pulls
 * React Native through the graph and breaks the vitest/Rollup transform on Flow
 * syntax — the same reason `expenseWriteBody.test.ts` tests the pure builder.
 */

import { describe, expect, it } from 'vitest';

import { serialiseExpense } from '../src/data/serialiseExpense';

const base = {
  description: '  Dinner  ',
  expenseDate: '2026-03-01',
  currency: 'INR',
  amount: 2000n,
  splitParams: { kind: 'equal' as const },
  participants: ['m1', 'm2'],
  payers: { m1: 2000n },
} satisfies Parameters<typeof serialiseExpense>[0];

describe('serialiseExpense', () => {
  it('carries baseVersionNo, receiptId and receiptShareUrl through the queue (parity)', () => {
    const out = serialiseExpense({
      ...base,
      baseVersionNo: 4,
      receiptId: 'r1',
      receiptShareUrl: 'https://drive.example/abc',
    });
    expect(out.baseVersionNo).toBe(4);
    expect(out.receiptId).toBe('r1');
    expect(out.receiptShareUrl).toBe('https://drive.example/abc');
  });

  it('defaults the parity fields to null when absent (a fresh create)', () => {
    const out = serialiseExpense(base);
    expect(out.baseVersionNo).toBeNull();
    expect(out.receiptId).toBeNull();
    expect(out.receiptShareUrl).toBeNull();
  });

  it('serialises money as decimal strings, never bigint or float', () => {
    const out = serialiseExpense({
      ...base,
      payers: { m1: 1500n, m2: 500n },
      expectedShares: { m1: 1000n, m2: 1000n },
    });
    expect(out.amount).toBe('2000');
    expect(out.payers).toEqual({ m1: '1500', m2: '500' });
    expect(out.expectedShares).toEqual({ m1: '1000', m2: '1000' });
  });

  it('trims the description and leaves expectedShares undefined when not given', () => {
    const out = serialiseExpense(base);
    expect(out.description).toBe('Dinner');
    expect(out.expectedShares).toBeUndefined();
  });
});
