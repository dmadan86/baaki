/**
 * Serialise an expense write into the JSON envelope the `/sync` queue stores on
 * disk (`driver.ts`) and later replays to the `sync` edge function.
 *
 * Kept in its own module — free of any React Native import — for two reasons:
 * the mapping is the whole serialisation surface of `useWriteExpense`, and it can
 * be unit-tested directly (importing `data/hooks.ts` pulls React Native through
 * the graph and breaks the vitest/Rollup transform on Flow syntax, the same
 * reason `expenseWriteBody.test.ts` tests the pure `@waves/core` builder). The
 * only dependency here is the `WriteExpenseInput` *type*, imported type-only so
 * it is erased at build and carries none of `api.ts`'s runtime deps.
 *
 * Every field the `sync` edge reads off the envelope (see `buildApplyExpenseArgs`
 * in `@waves/core`, and the `payload.*` reads in `supabase/functions/sync`) must
 * be produced here, or an offline write silently loses it relative to the direct
 * `expense-write` path — the parity hole this contract exists to prevent.
 */

import { serialiseSplitParams } from '@waves/core';

import type { WriteExpenseInput } from './api';

/**
 * bigint does not survive JSON, and the queue is JSON on disk. Amounts go as
 * decimal strings and come back exact — the one thing money may never do here
 * is round-trip through a float.
 */
export function serialiseExpense(
  input: Omit<WriteExpenseInput, 'groupId'>,
): Record<string, unknown> {
  return {
    description: input.description.trim(),
    category: input.category ?? null,
    expenseDate: input.expenseDate,
    currency: input.currency,
    amount: input.amount.toString(),
    fx: input.fx ?? null,
    splitParams: serialiseSplitParams(input.splitParams),
    participants: input.participants,
    payers: Object.fromEntries(
      Object.entries(input.payers).map(([member, amount]) => [member, amount.toString()]),
    ),
    expectedShares: input.expectedShares
      ? Object.fromEntries(
          Object.entries(input.expectedShares).map(([member, share]) => [member, share.toString()]),
        )
      : undefined,
    notes: input.notes ?? null,
    paymentMethod: input.paymentMethod ?? null,
    categoryMeta: input.categoryMeta ?? null,
    location: input.location ?? null,
    // The `/sync` edge reads all three off the queued envelope (buildApplyExpenseArgs
    // in @waves/core), so they must survive the queue or an offline write silently
    // loses them versus the direct path. baseVersionNo is the one an offline *edit*
    // sets today (add-expense.tsx) — dropping it skipped the concurrent-edit conflict
    // check (TDR §4.4); receiptId/receiptShareUrl are carried for the same parity.
    baseVersionNo: input.baseVersionNo ?? null,
    receiptId: input.receiptId ?? null,
    receiptShareUrl: input.receiptShareUrl ?? null,
  };
}
