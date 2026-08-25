/**
 * `api.writeExpense()` posts the body that `buildExpenseWriteBody` (@waves/core)
 * produces — the same builder the web client and, via the edge, `/sync` use. It
 * used to hand-roll the body and silently drop `categoryMeta` and
 * `baseVersionNo`, so a direct write lost custom-tag display and skipped the
 * concurrent-edit conflict check.
 *
 * This asserts the builder — not `api.ts` itself — on purpose: `data/api.ts`
 * pulls React Native (storage, the Supabase client, i18n) through its imports,
 * and a React-Native module in the vitest graph breaks Rollup on Flow syntax.
 * The body builder is the whole of `writeExpense`'s serialisation surface and is
 * dependency-free, so testing it here keeps the tested surface RN-free while
 * still pinning exactly what the function sends.
 */

import { describe, expect, it } from 'vitest';

import { buildExpenseWriteBody, type CategoryMeta } from '@waves/core';

const meta: CategoryMeta = { label: 'Chai', icon: 'cup', tint: 'peach' };

describe('writeExpense body', () => {
  it('includes categoryMeta and baseVersionNo (an edit)', () => {
    const body = buildExpenseWriteBody({
      groupId: 'g1',
      expenseId: 'e1',
      description: 'Dinner',
      expenseDate: '2026-03-01',
      currency: 'INR',
      amount: 2000n,
      splitParams: { kind: 'equal' },
      participants: ['m1', 'm2'],
      payers: { m1: 2000n },
      categoryMeta: meta,
      baseVersionNo: 4,
      clientMutationId: 'mut-1',
    });

    expect(body.categoryMeta).toEqual(meta);
    expect(body.baseVersionNo).toBe(4);
    // And the fields that were always sent are still there and wire-safe.
    expect(body.amount).toBe('2000');
    expect(body.payers).toEqual({ m1: '2000' });
    expect(body.clientMutationId).toBe('mut-1');
  });

  it('sends explicit nulls for categoryMeta/baseVersionNo on a plain create', () => {
    const body = buildExpenseWriteBody({
      groupId: 'g1',
      description: 'Coffee',
      expenseDate: '2026-03-02',
      currency: 'INR',
      amount: 100n,
      splitParams: { kind: 'equal' },
      participants: ['m1'],
      payers: { m1: 100n },
      clientMutationId: 'mut-2',
    });

    // A version is a full snapshot: an omitted field must be an explicit null,
    // never absent, or an edit would inherit the previous version's value.
    expect(body.categoryMeta).toBeNull();
    expect(body.baseVersionNo).toBeNull();
  });
});
