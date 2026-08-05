/**
 * M2: what the database has to guarantee before a client is allowed to go
 * offline (ADR-005 / TDR §4).
 *
 * The client-side rules — queue ordering, backoff, reconciliation — are
 * property-tested in @baaki/core. These are the server-side halves that only
 * real Postgres can prove: that the cursor never skips a change, that a
 * replayed mutation is free, and that two people editing the same expense from
 * two dead zones both keep their work.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { big, connect, expectDenied, seedGroup } from './helpers.js';

let client: Client;

async function createProfile(name: string): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, $2)`, [id, name]);
  return id;
}

async function asUser<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query(`SET ROLE authenticated`);
  try {
    return await run();
  } finally {
    await client.query(`RESET ROLE`);
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

interface ApplyResult {
  expenseId: string;
  versionId: string;
  versionNo: number;
  replayed: boolean;
  superseded: boolean;
  supersededVersionNo: number | null;
}

async function applyExpense(params: {
  groupId: string;
  author: string;
  amount: bigint;
  payers: { memberId: string; amount: string }[];
  shares: { memberId: string; amount: string }[];
  expenseId?: string | null;
  mutationId?: string | null;
  baseVersionNo?: number | null;
  description?: string;
}): Promise<ApplyResult> {
  const result = await client.query(
    `SELECT baaki_apply_expense($1, $2, $3, $8, NULL, '2026-03-01', 'INR', $4,
                                'equal', '{"kind":"equal"}'::jsonb, $5::jsonb, $6::jsonb, $7,
                                NULL, NULL, $9)
       AS out`,
    [
      params.groupId,
      params.expenseId ?? null,
      params.author,
      params.amount.toString(),
      JSON.stringify(params.payers),
      JSON.stringify(params.shares),
      params.mutationId ?? null,
      params.description ?? 'Dinner',
      params.baseVersionNo ?? null,
    ],
  );
  return result.rows[0]?.out as ApplyResult;
}

/** An even two-way split, which is all these tests need. */
const halves = (a: string, b: string, amount: bigint) => ({
  payers: [{ memberId: a, amount: amount.toString() }],
  shares: [
    { memberId: a, amount: (amount / 2n).toString() },
    { memberId: b, amount: (amount - amount / 2n).toString() },
  ],
});

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

describe('the sync cursor (TDR §4)', () => {
  it('advances for anything a client could pull, including the group itself', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const seqOf = async (): Promise<bigint> =>
      big(
        (await client.query(`SELECT updated_seq FROM groups WHERE id = $1`, [groupId])).rows[0]
          ?.updated_seq,
      );

    const start = await seqOf();

    // Renaming a group used to change nothing a client could see, so a device
    // that was offline during the rename never learned about it.
    await client.query(`UPDATE groups SET name = 'Goa trip, revised' WHERE id = $1`, [groupId]);
    const afterRename = await seqOf();
    expect(afterRename).toBeGreaterThan(start);

    await applyExpense({ groupId, author: a, amount: 1000n, ...halves(a, b, 1000n) });
    const afterExpense = await seqOf();
    expect(afterExpense).toBeGreaterThan(afterRename);

    // Every row carries a seq no higher than the group's own high-water mark,
    // which is what makes "pull everything above my cursor" complete.
    const rows = await client.query(
      `SELECT max(updated_seq) AS high FROM (
         SELECT updated_seq FROM expenses WHERE group_id = $1
         UNION ALL SELECT updated_seq FROM group_members WHERE group_id = $1
         UNION ALL SELECT updated_seq FROM activity_log WHERE group_id = $1
       ) all_rows`,
      [groupId],
    );
    expect(big(rows.rows[0]?.high)).toBeLessThanOrEqual(afterExpense);
  });

  it('never issues the same sequence number twice in a group', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    for (let index = 0; index < 5; index += 1) {
      await applyExpense({ groupId, author: a, amount: 1000n, ...halves(a, b, 1000n) });
    }

    const { rows } = await client.query(
      `SELECT updated_seq, count(*) AS n FROM expenses WHERE group_id = $1
        GROUP BY updated_seq HAVING count(*) > 1`,
      [groupId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('conflict versioning (TDR §4.4)', () => {
  it('keeps both edits and lets the later receipt win', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const created = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      description: 'Dinner',
      ...halves(a, b, 1000n),
    });
    expect(created.versionNo).toBe(1);

    // Asha edits v1 while online.
    const asha = await applyExpense({
      groupId,
      author: a,
      expenseId: created.expenseId,
      amount: 2000n,
      description: "Asha's edit",
      baseVersionNo: 1,
      ...halves(a, b, 2000n),
    });
    expect(asha.superseded).toBe(false);

    // Bharath was in a dead zone and edited the same v1. His mutation arrives
    // second, so it wins — but Asha's version is not destroyed.
    const bharath = await applyExpense({
      groupId,
      author: b,
      expenseId: created.expenseId,
      amount: 3000n,
      description: "Bharath's edit",
      baseVersionNo: 1,
      ...halves(b, a, 3000n),
    });

    expect(bharath.superseded).toBe(true);
    expect(bharath.supersededVersionNo).toBe(asha.versionNo);
    expect(bharath.versionNo).toBe(3);

    // Later receipt is what the group sees.
    const current = await client.query(
      `SELECT ev.description, ev.amount FROM expenses e
         JOIN expense_versions ev ON ev.id = e.current_version_id
        WHERE e.id = $1`,
      [created.expenseId],
    );
    expect(current.rows[0]?.description).toBe("Bharath's edit");

    // Nothing was lost: all three versions are still there (ADR-004).
    const versions = await client.query(
      `SELECT version_no, description FROM expense_versions
        WHERE expense_id = $1 ORDER BY version_no`,
      [created.expenseId],
    );
    expect(versions.rows.map((row) => row.description)).toEqual([
      'Dinner',
      "Asha's edit",
      "Bharath's edit",
    ]);
  });

  it('surfaces the losing edit in the activity feed', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const created = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      ...halves(a, b, 1000n),
    });
    await applyExpense({
      groupId,
      author: a,
      expenseId: created.expenseId,
      amount: 2000n,
      description: "Asha's edit",
      baseVersionNo: 1,
      ...halves(a, b, 2000n),
    });
    await applyExpense({
      groupId,
      author: b,
      expenseId: created.expenseId,
      amount: 3000n,
      baseVersionNo: 1,
      ...halves(b, a, 3000n),
    });

    const { rows } = await client.query(
      `SELECT payload FROM activity_log
        WHERE group_id = $1 AND verb = 'superseded' AND object_id = $2`,
      [groupId, created.expenseId],
    );
    expect(rows).toHaveLength(1);
    // Enough for "Asha's edit replaced yours — view/restore" (TDR §4.4).
    expect(rows[0]?.payload).toMatchObject({
      supersededVersionNo: 2,
      supersededAuthorMemberId: a,
      supersededDescription: "Asha's edit",
      baseVersionNo: 1,
      winningVersionNo: 3,
    });
  });

  it('does not cry conflict when the edit was based on the current version', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const created = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      ...halves(a, b, 1000n),
    });
    const second = await applyExpense({
      groupId,
      author: a,
      expenseId: created.expenseId,
      amount: 2000n,
      baseVersionNo: 1,
      ...halves(a, b, 2000n),
    });
    const third = await applyExpense({
      groupId,
      author: b,
      expenseId: created.expenseId,
      amount: 3000n,
      baseVersionNo: second.versionNo,
      ...halves(b, a, 3000n),
    });

    expect(third.superseded).toBe(false);
    const { rows } = await client.query(
      `SELECT count(*) AS n FROM activity_log WHERE group_id = $1 AND verb = 'superseded'`,
      [groupId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('leaves balances correct after a conflict', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const created = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      ...halves(a, b, 1000n),
    });
    await applyExpense({
      groupId,
      author: a,
      expenseId: created.expenseId,
      amount: 2000n,
      baseVersionNo: 1,
      ...halves(a, b, 2000n),
    });
    await applyExpense({
      groupId,
      author: b,
      expenseId: created.expenseId,
      amount: 3000n,
      baseVersionNo: 1,
      ...halves(b, a, 3000n),
    });

    // Only the winning version counts: Bharath paid 3000, they split it evenly.
    const { rows } = await client.query(
      `SELECT member_id, balance FROM group_balances WHERE group_id = $1 ORDER BY balance`,
      [groupId],
    );
    const balances = new Map(rows.map((row) => [String(row.member_id), big(row.balance)]));
    expect(balances.get(b)).toBe(1500n);
    expect(balances.get(a)).toBe(-1500n);
    expect([...balances.values()].reduce((sum, value) => sum + value, 0n)).toBe(0n);
  });
});

describe('replaying a queue is free (ADR-005)', () => {
  it('returns the original group instead of creating a second one', async () => {
    const profileId = await createProfile('Asha');
    const groupId = randomUUID();

    const create = async (): Promise<string> =>
      asUser(profileId, async () => {
        const result = await client.query(
          `SELECT baaki_create_group('Goa trip', 'trip', 'INR', NULL, true, $1) AS id`,
          [groupId],
        );
        return String(result.rows[0]?.id);
      });

    expect(await create()).toBe(groupId);
    expect(await create()).toBe(groupId);

    const { rows } = await client.query(`SELECT count(*) AS n FROM groups WHERE id = $1`, [
      groupId,
    ]);
    expect(Number(rows[0]?.n)).toBe(1);
    // And exactly one membership, not two.
    const members = await client.query(
      `SELECT count(*) AS n FROM group_members WHERE group_id = $1`,
      [groupId],
    );
    expect(Number(members.rows[0]?.n)).toBe(1);
  });

  it('will not let one person claim a group id somebody else already used', async () => {
    const owner = await createProfile('Asha');
    const stranger = await createProfile('Mallory');
    const groupId = randomUUID();

    await asUser(owner, () =>
      client.query(`SELECT baaki_create_group('Goa trip', 'trip', 'INR', NULL, true, $1)`, [
        groupId,
      ]),
    );

    const message = await asUser(stranger, () =>
      expectDenied(
        client.query(`SELECT baaki_create_group('Mine now', 'trip', 'INR', NULL, true, $1)`, [
          groupId,
        ]),
      ),
    );
    expect(message).toMatch(/GROUP_EXISTS/);
  });

  it('adds a ghost once, however many times the mutation is retried', async () => {
    const profileId = await createProfile('Asha');
    const groupId = randomUUID();
    await asUser(profileId, () =>
      client.query(`SELECT baaki_create_group('Goa trip', 'trip', 'INR', NULL, true, $1)`, [
        groupId,
      ]),
    );

    const ghostId = randomUUID();
    const add = async (): Promise<string> =>
      asUser(profileId, async () => {
        const result = await client.query(`SELECT baaki_add_ghost_member($1, 'Priya', $2) AS id`, [
          groupId,
          ghostId,
        ]);
        return String(result.rows[0]?.id);
      });

    expect(await add()).toBe(ghostId);
    expect(await add()).toBe(ghostId);

    const { rows } = await client.query(
      `SELECT count(*) AS n FROM group_members WHERE group_id = $1 AND ghost_name = 'Priya'`,
      [groupId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('refuses to add a ghost to a group you are not in', async () => {
    const owner = await createProfile('Asha');
    const stranger = await createProfile('Mallory');
    const groupId = randomUUID();
    await asUser(owner, () =>
      client.query(`SELECT baaki_create_group('Goa trip', 'trip', 'INR', NULL, true, $1)`, [
        groupId,
      ]),
    );

    const message = await asUser(stranger, () =>
      expectDenied(client.query(`SELECT baaki_add_ghost_member($1, 'Priya', NULL)`, [groupId])),
    );
    expect(message).toMatch(/NOT_A_MEMBER/);
  });

  it('replays an expense to the same version rather than appending another', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const mutationId = randomUUID();

    const first = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      mutationId,
      ...halves(a, b, 1000n),
    });
    const replay = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      mutationId,
      expenseId: first.expenseId,
      ...halves(a, b, 1000n),
    });

    expect(replay.replayed).toBe(true);
    expect(replay.versionId).toBe(first.versionId);

    const { rows } = await client.query(
      `SELECT count(*) AS n FROM expense_versions WHERE expense_id = $1`,
      [first.expenseId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});

describe('the idempotency ledger', () => {
  it('is invisible to everyone but the service role (ADR-013)', async () => {
    const profileId = await createProfile('Asha');
    await client.query(
      `INSERT INTO sync_mutations (client_mutation_id, profile_id, kind, result)
       VALUES ($1, $2, 'expense.create', '{"ok":true}'::jsonb)`,
      [randomUUID(), profileId],
    );

    // Even the profile the row belongs to cannot read it: this is the edge
    // function's own bookkeeping, not user data.
    const rows = await asUser(profileId, async () => {
      const result = await client.query(`SELECT * FROM sync_mutations`);
      return result.rows;
    });
    expect(rows).toHaveLength(0);

    const message = await asUser(profileId, () =>
      expectDenied(
        client.query(
          `INSERT INTO sync_mutations (client_mutation_id, profile_id, kind)
           VALUES ($1, $2, 'expense.create')`,
          [randomUUID(), profileId],
        ),
      ),
    );
    expect(message).toMatch(/row-level security|permission denied/i);
  });
});
