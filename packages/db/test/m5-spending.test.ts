/**
 * Where the money went (M5, TDR §8).
 *
 * A spending chart is the one screen in this app that is allowed to be
 * approximate about nothing and is still not the ledger — nobody settles up
 * from it. What it must never do is disagree with the ledger about facts:
 * every rupee of every live expense appears exactly once, a deleted expense
 * appears nowhere, an edited one appears at its current figure, and a person
 * outside the group sees none of it.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, big, connect, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

interface SpendingRow {
  memberId: string;
  currency: string;
  category: string;
  month: string;
  shareAmount: bigint;
  expenseCount: number;
}

function localDate(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

async function spending(groupId: string): Promise<SpendingRow[]> {
  const result = await client.query(
    `SELECT member_id, currency, category, month, share_amount, expense_count
       FROM waves_group_spending($1)
      ORDER BY category, month, member_id`,
    [groupId],
  );
  return result.rows.map((row) => ({
    memberId: String(row.member_id),
    currency: String(row.currency),
    category: String(row.category),
    // node-pg parses a `date` into a JS Date at *local* midnight, so
    // `toISOString()` reports the day before anywhere east of UTC. Read the
    // local parts instead. (PostgREST hands the app a plain 'YYYY-MM-DD'
    // string and never has this problem.)
    month: localDate(row.month as Date),
    shareAmount: big(row.share_amount),
    expenseCount: Number(row.expense_count),
  }));
}

const total = (rows: SpendingRow[]): bigint => rows.reduce((sum, row) => sum + row.shareAmount, 0n);

describe('waves_group_spending', () => {
  it('adds up to exactly what the group spent, split by category and month', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 3 });

    await addEqualSplitExpense(client, {
      groupId,
      amount: 90000n,
      payers: { [memberIds[0]!]: 90000n },
      participants: memberIds,
      category: 'food',
      date: '2026-03-04',
    });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 30000n,
      payers: { [memberIds[1]!]: 30000n },
      participants: memberIds,
      category: 'travel',
      date: '2026-03-20',
    });
    // Same category, next month: the month must keep them apart.
    await addEqualSplitExpense(client, {
      groupId,
      amount: 60000n,
      payers: { [memberIds[0]!]: 60000n },
      participants: memberIds,
      category: 'food',
      date: '2026-04-02',
    });

    const rows = await spending(groupId);
    expect(total(rows)).toBe(180000n);

    const months = new Set(rows.map((row) => `${row.category}:${row.month}`));
    expect(months).toEqual(new Set(['food:2026-03-01', 'food:2026-04-01', 'travel:2026-03-01']));

    // Every member carries a third of each expense; the odd paisa rotation is
    // the ledger's, and this must report whatever it decided rather than
    // dividing again.
    const mine = rows.filter((row) => row.memberId === memberIds[2]);
    const shares = await client.query(
      `SELECT SUM(s.amount)::bigint AS owed
         FROM expense_shares s
         JOIN expense_versions ev ON ev.id = s.expense_version_id
         JOIN expenses e ON e.current_version_id = ev.id AND e.deleted_at IS NULL
        WHERE e.group_id = $1 AND s.member_id = $2`,
      [groupId, memberIds[2]],
    );
    expect(total(mine)).toBe(big(shares.rows[0]!.owed));
  });

  it('files a missing or blank category under "other", never null', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [memberIds[0]!]: 10000n },
      participants: memberIds,
      category: null,
    });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [memberIds[0]!]: 10000n },
      participants: memberIds,
      // Whitespace and case are an importer's doing, not a second category.
      category: '  Food  ',
    });

    const rows = await spending(groupId);
    expect(new Set(rows.map((row) => row.category))).toEqual(new Set(['other', 'food']));
  });

  it('forgets a deleted expense and follows an edited one', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const kept = await addEqualSplitExpense(client, {
      groupId,
      amount: 50000n,
      payers: { [memberIds[0]!]: 50000n },
      participants: memberIds,
      category: 'food',
    });
    const removed = await addEqualSplitExpense(client, {
      groupId,
      amount: 20000n,
      payers: { [memberIds[0]!]: 20000n },
      participants: memberIds,
      category: 'travel',
    });

    await client.query(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, [removed.expenseId]);
    expect(total(await spending(groupId))).toBe(50000n);

    // Append a second version at a different figure and in a different
    // category — ADR-004 keeps the old one, and spending must not.
    const versionId = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO expense_versions
           (id, expense_id, version_no, author_member_id, description, category, expense_date,
            currency, amount, split_type, split_params)
         VALUES ($1, $2, 2, $3, 'Dinner', 'entertainment', '2026-03-01', 'INR', 80000, 'equal',
                 '{"kind":"equal"}'::jsonb)`,
        [versionId, kept.expenseId, memberIds[0]],
      );
      for (const memberId of memberIds) {
        await client.query(
          `INSERT INTO expense_payers (id, expense_version_id, member_id, amount)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), versionId, memberId, memberId === memberIds[0] ? '80000' : '0'],
        );
        await client.query(
          `INSERT INTO expense_shares (id, expense_version_id, member_id, amount)
           VALUES ($1, $2, $3, 40000)`,
          [randomUUID(), versionId, memberId],
        );
      }
      await client.query(`UPDATE expenses SET current_version_id = $1 WHERE id = $2`, [
        versionId,
        kept.expenseId,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const rows = await spending(groupId);
    expect(total(rows)).toBe(80000n);
    expect(rows.map((row) => row.category)).toEqual(['entertainment', 'entertainment']);
  });

  it('keeps currencies apart rather than adding them up', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 100000n,
      payers: { [memberIds[0]!]: 100000n },
      participants: memberIds,
      category: 'stay',
    });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 4000n,
      payers: { [memberIds[0]!]: 4000n },
      participants: memberIds,
      category: 'stay',
      currency: 'EUR',
    });

    const rows = await spending(groupId);
    const byCurrency = new Map(rows.map((row) => [`${row.currency}:${row.memberId}`, row]));
    expect(byCurrency.size).toBe(4);
    expect(total(rows.filter((row) => row.currency === 'INR'))).toBe(100000n);
    expect(total(rows.filter((row) => row.currency === 'EUR'))).toBe(4000n);
  });

  it('shows a non-member nothing', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [memberIds[0]!]: 10000n },
      participants: memberIds,
      category: 'food',
    });

    const stranger = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Stranger')`, [
      stranger,
    ]);

    await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: stranger, role: 'authenticated' }),
    ]);
    await client.query(`SET ROLE authenticated`);
    try {
      const result = await client.query(`SELECT * FROM waves_group_spending($1)`, [groupId]);
      // RLS on the base tables, not an error: a stranger is told nothing about
      // the group, including whether it exists.
      expect(result.rows).toEqual([]);
    } finally {
      await client.query(`RESET ROLE`);
      await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  });
});
