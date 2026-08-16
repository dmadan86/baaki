import { describe, expect, it } from 'vitest';

import { computeSpendingRows } from '@/data/spending';
import type { ExpenseRow } from '@/data/types';

/**
 * A minimal expense — only the fields the aggregation reads (deleted_at and the
 * current version's currency, category, date and shares). The rest is filled so
 * the shape is a real ExpenseRow.
 */
function expense(over: {
  id?: string;
  deleted?: boolean;
  version?: null;
  currency?: string;
  category?: string | null;
  date?: string;
  shares?: { member_id: string; amount: string }[];
}): ExpenseRow {
  const version =
    over.version === null
      ? null
      : {
          id: `${over.id ?? 'e'}-v1`,
          version_no: 1,
          description: 'x',
          category: over.category === undefined ? 'food' : over.category,
          expense_date: over.date ?? '2026-03-15',
          currency: over.currency ?? 'INR',
          amount: '0',
          split_type: 'equal',
          split_params: { kind: 'equal', members: [] },
          author_member_id: null,
          notes: null,
          created_at: '2026-03-15T00:00:00Z',
          payers: [],
          shares: over.shares ?? [{ member_id: 'm1', amount: '100' }],
        };
  return {
    id: over.id ?? 'e1',
    group_id: 'g1',
    deleted_at: over.deleted ? '2026-03-16T00:00:00Z' : null,
    created_at: '2026-03-15T00:00:00Z',
    currentVersion: version,
  } as unknown as ExpenseRow;
}

/** Find the single row for a (member, category, month, currency) key. */
function find(
  rows: ReturnType<typeof computeSpendingRows>,
  member: string,
  category: string,
  month: string,
  currency = 'INR',
) {
  return rows.find(
    (r) =>
      r.member_id === member &&
      r.category === category &&
      r.month === month &&
      r.currency === currency,
  );
}

describe('computeSpendingRows', () => {
  it('sums a member’s shares within one category, currency and month', () => {
    const rows = computeSpendingRows([
      expense({
        id: 'a',
        category: 'food',
        date: '2026-03-01',
        shares: [{ member_id: 'm1', amount: '100' }],
      }),
      expense({
        id: 'b',
        category: 'food',
        date: '2026-03-28',
        shares: [{ member_id: 'm1', amount: '250' }],
      }),
    ]);
    const row = find(rows, 'm1', 'food', '2026-03-01');
    expect(row?.share_amount).toBe('350');
    expect(row?.expense_count).toBe(2);
  });

  it('emits a row per member of the same expense', () => {
    const rows = computeSpendingRows([
      expense({
        category: 'travel',
        date: '2026-03-10',
        shares: [
          { member_id: 'm1', amount: '600' },
          { member_id: 'm2', amount: '400' },
        ],
      }),
    ]);
    expect(find(rows, 'm1', 'travel', '2026-03-01')?.share_amount).toBe('600');
    expect(find(rows, 'm2', 'travel', '2026-03-01')?.share_amount).toBe('400');
  });

  it('normalises the category: trims, lower-cases, and defaults to other', () => {
    const rows = computeSpendingRows([
      expense({ id: 'a', category: '  Food ', shares: [{ member_id: 'm1', amount: '10' }] }),
      expense({ id: 'b', category: 'FOOD', shares: [{ member_id: 'm1', amount: '20' }] }),
      expense({ id: 'c', category: null, shares: [{ member_id: 'm1', amount: '5' }] }),
      expense({ id: 'd', category: '', shares: [{ member_id: 'm1', amount: '7' }] }),
    ]);
    // 'Food' and 'FOOD' collapse to one 'food' bucket.
    expect(find(rows, 'm1', 'food', '2026-03-01')?.share_amount).toBe('30');
    // null and '' both fall to 'other'.
    expect(find(rows, 'm1', 'other', '2026-03-01')?.share_amount).toBe('12');
  });

  it('buckets by the first of the month without a timezone shift', () => {
    const rows = computeSpendingRows([
      expense({ date: '2026-01-01', shares: [{ member_id: 'm1', amount: '1' }] }),
    ]);
    // A 1st-of-month date must stay in January, never slip to December.
    expect(rows[0]?.month).toBe('2026-01-01');
  });

  it('keeps currencies apart', () => {
    const rows = computeSpendingRows([
      expense({ id: 'a', currency: 'INR', shares: [{ member_id: 'm1', amount: '100' }] }),
      expense({ id: 'b', currency: 'EUR', shares: [{ member_id: 'm1', amount: '200' }] }),
    ]);
    expect(find(rows, 'm1', 'food', '2026-03-01', 'INR')?.share_amount).toBe('100');
    expect(find(rows, 'm1', 'food', '2026-03-01', 'EUR')?.share_amount).toBe('200');
  });

  it('excludes a deleted expense — a deleted one is not spending', () => {
    const rows = computeSpendingRows([
      expense({ id: 'a', deleted: true, shares: [{ member_id: 'm1', amount: '999' }] }),
    ]);
    expect(rows).toEqual([]);
  });

  it('skips an expense with no current version', () => {
    const rows = computeSpendingRows([expense({ version: null })]);
    expect(rows).toEqual([]);
  });

  it('counts distinct expenses, not shares', () => {
    // Same member, category, month across three expenses → one row, count 3.
    const rows = computeSpendingRows([
      expense({ id: 'a', shares: [{ member_id: 'm1', amount: '1' }] }),
      expense({ id: 'b', shares: [{ member_id: 'm1', amount: '1' }] }),
      expense({ id: 'c', shares: [{ member_id: 'm1', amount: '1' }] }),
    ]);
    expect(find(rows, 'm1', 'food', '2026-03-01')?.expense_count).toBe(3);
  });

  it('sums large minor-unit amounts exactly, in bigint not float', () => {
    const rows = computeSpendingRows([
      expense({ id: 'a', shares: [{ member_id: 'm1', amount: '9007199254740993' }] }),
      expense({ id: 'b', shares: [{ member_id: 'm1', amount: '2' }] }),
    ]);
    // 2^53 + 1 + 2 — a Number would lose the low bit; a bigint does not.
    expect(find(rows, 'm1', 'food', '2026-03-01')?.share_amount).toBe('9007199254740995');
  });

  it('is empty for no expenses', () => {
    expect(computeSpendingRows([])).toEqual([]);
  });
});
