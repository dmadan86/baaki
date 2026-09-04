/**
 * Where the money went — computed on the device from the mirrored ledger.
 *
 * This is the local-first twin of the `waves_group_spending` RPC (M5, TDR §8):
 * the same per-member, per-currency, per-category, per-month share totals, but
 * derived from the SQLite mirror the group screen already holds instead of a
 * network round-trip (ADR-005). Insights is a read of expenses the phone
 * already has, so it should work with no connection like every other read.
 *
 * It matches the server function exactly so the two are interchangeable:
 *   * only the current version of a non-deleted expense counts;
 *   * a category is lower-cased and trimmed, and anything empty or absent lands
 *     in 'other';
 *   * the month is the first day of the expense's month, taken by slicing the
 *     'YYYY-MM-DD' string so no timezone can move it;
 *   * nothing is converted between currencies and nothing is re-divided — the
 *     shares are exactly what the ledger stored, odd paisa and all (ADR-003).
 *
 * Because it reads the group's overlaid rows, an expense still sitting in the
 * mutation queue counts too — which is more current than the server-only RPC,
 * and correct: it is money the group has spent.
 */

import type { CategoryMeta } from '@waves/core';

import type { SpendingRow } from './api';
import type { ExpenseRow } from './types';

/** Lower-case, trim, and fall back to 'other' — matches the SQL COALESCE. */
function normaliseCategory(category: string | null | undefined): string {
  const trimmed = (category ?? '').trim().toLowerCase();
  return trimmed === '' ? 'other' : trimmed;
}

/**
 * First day of the month as 'YYYY-MM-01', taken from the leading 'YYYY-MM' of
 * the date string. Deliberately not `new Date(...)`: parsing would apply the
 * phone's timezone and, east of UTC, file a 1st-of-month expense under the
 * previous month.
 */
function firstOfMonth(expenseDate: string): string {
  return `${expenseDate.slice(0, 7)}-01`;
}

interface Bucket {
  member_id: string;
  currency: string;
  category: string;
  /** A custom tag's snapshot, so insights labels the bar with the tag rather
   *  than folding it into "Other" (extends TDR §8). Null for a built-in. */
  categoryMeta: CategoryMeta | null;
  month: string;
  amount: bigint;
  expenseIds: Set<string>;
}

// U+001F (unit separator) cannot appear in a uuid, currency, category or date,
// so it is a safe delimiter for the composite bucket key.
const KEY_SEP = String.fromCharCode(0x1f); // U+001F unit separator

/**
 * Aggregate a group's expenses into spending rows, one per
 * (member, currency, category, month) — the finest grain the charts need, and
 * the exact shape `fetchGroupSpending` returns, so `insights` can swap the RPC
 * for this with no other change.
 */
export function computeSpendingRows(expenses: readonly ExpenseRow[]): SpendingRow[] {
  const buckets = new Map<string, Bucket>();

  for (const expense of expenses) {
    // A deleted expense is not spending (matches `e.deleted_at IS NULL`).
    if (expense.deleted_at) continue;
    const version = expense.currentVersion;
    if (!version) continue;

    const currency = version.currency;
    const category = normaliseCategory(version.category);
    const categoryMeta = version.category_meta ?? null;
    const month = firstOfMonth(version.expense_date);

    for (const share of version.shares) {
      const key = [share.member_id, currency, category, month].join(KEY_SEP);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          member_id: share.member_id,
          currency,
          category,
          categoryMeta,
          month,
          amount: 0n,
          expenseIds: new Set(),
        };
        buckets.set(key, bucket);
      }
      bucket.amount += BigInt(share.amount);
      bucket.expenseIds.add(expense.id);
    }
  }

  return [...buckets.values()].map((bucket) => ({
    member_id: bucket.member_id,
    currency: bucket.currency,
    category: bucket.category,
    category_meta: bucket.categoryMeta,
    month: bucket.month,
    // BIGINT is a string across the wire; keep the same so callers `BigInt(...)`
    // it exactly as they do the RPC's rows.
    share_amount: bucket.amount.toString(),
    expense_count: bucket.expenseIds.size,
  }));
}
