/**
 * Per-expense comments — the permission matrix from the feature spec, enforced
 * in the RPCs. Every case here guards the one asymmetry the feature turns on:
 * any member speaks, the author owns their own words, and only an admin reaches
 * across to someone else's — a non-admin never can.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, connect, expectDenied, seedGroup } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/** Run as a profile and commit — reads across role switches need the seed rows. */
async function as<T>(profileId: string | null, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    profileId
      ? JSON.stringify({ sub: profileId, role: 'authenticated' })
      : JSON.stringify({ role: 'anon' }),
  ]);
  await client.query(`SET ROLE ${profileId ? 'authenticated' : 'anon'}`);
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
  }
}

// A group of three: m0 = admin, m1 & m2 = plain members. One expense. An
// outsider profile who is in no group. m0..m2 are the seeded members.
let g: { groupId: string; profileIds: string[]; memberIds: string[] };
let expenseId: string;
let outsider: string;

beforeAll(async () => {
  g = await seedGroup(client, { memberCount: 3, name: 'Comments' });
  outsider = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Outsider', 'INR')`,
    [outsider],
  );
  ({ expenseId } = await addEqualSplitExpense(client, {
    groupId: g.groupId,
    payers: { [g.memberIds[0] as string]: 3000n },
    participants: g.memberIds,
    amount: 3000n,
  }));
});

beforeEach(async () => {
  await client.query(`DELETE FROM expense_comments WHERE group_id = $1`, [g.groupId]);
});

const P = (i: number) => g.profileIds[i] as string;

/** Add a comment as a profile; returns the new comment id. */
async function addComment(profileId: string, body: string, id = randomUUID()): Promise<string> {
  await as(profileId, () =>
    client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
      g.groupId,
      expenseId,
      id,
      body,
    ]),
  );
  return id;
}

/** How many live comments this profile can see (RLS + client filter of deleted). */
const visibleTo = (profileId: string | null) =>
  as(profileId, () =>
    client
      .query(
        `SELECT count(*)::int AS n FROM expense_comments WHERE expense_id = $1 AND deleted_at IS NULL`,
        [expenseId],
      )
      .then((r) => r.rows[0].n as number),
  );

const rowById = (id: string) =>
  client
    .query(
      `SELECT author_member_id, deleted_at, deleted_by, edited_at, flagged_at, flagged_by
         FROM expense_comments WHERE id = $1`,
      [id],
    )
    .then((r) => r.rows[0]);

describe('expense comments — permission matrix', () => {
  it('T1 any member adds and every member reads it', async () => {
    await addComment(P(1), 'What was this for?');
    expect(await visibleTo(P(0))).toBe(1);
    expect(await visibleTo(P(1))).toBe(1);
    expect(await visibleTo(P(2))).toBe(1);
  });

  it('T2 a non-member cannot add and cannot read', async () => {
    const msg = await expectDenied(
      as(outsider, () =>
        client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
          g.groupId,
          expenseId,
          randomUUID(),
          'sneaking in',
        ]),
      ),
    );
    expect(msg).toMatch(/NOT_A_MEMBER/);
    await addComment(P(1), 'members only');
    expect(await visibleTo(outsider)).toBe(0);
  });

  it('T3 anon cannot add and cannot read', async () => {
    await addComment(P(1), 'visible to members');
    expect(await visibleTo(null)).toBe(0);
    await expectDenied(
      as(null, () =>
        client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
          g.groupId,
          expenseId,
          randomUUID(),
          'anon comment',
        ]),
      ),
    );
  });

  it('T4 the author edits their own and it stamps edited_at', async () => {
    const id = await addComment(P(1), 'frist draft');
    await as(P(1), () =>
      client.query(`SELECT baaki_edit_expense_comment($1, $2)`, [id, 'fixed typo']),
    );
    const row = await rowById(id);
    expect(row.edited_at).not.toBeNull();
    const body = await client
      .query(`SELECT body FROM expense_comments WHERE id = $1`, [id])
      .then((r) => r.rows[0].body);
    expect(body).toBe('fixed typo');
  });

  it("T5 a non-author member cannot edit someone else's", async () => {
    const id = await addComment(P(1), 'my words');
    const msg = await expectDenied(
      as(P(2), () => client.query(`SELECT baaki_edit_expense_comment($1, $2)`, [id, 'not yours'])),
    );
    expect(msg).toMatch(/NOT_YOUR_COMMENT/);
  });

  it("T6 even an admin cannot edit someone else's (edit is author-only)", async () => {
    const id = await addComment(P(1), 'my words');
    const msg = await expectDenied(
      as(P(0), () => client.query(`SELECT baaki_edit_expense_comment($1, $2)`, [id, 'admin edit'])),
    );
    expect(msg).toMatch(/NOT_YOUR_COMMENT/);
  });

  it('T7 the author deletes their own', async () => {
    const id = await addComment(P(1), 'delete me');
    await as(P(1), () => client.query(`SELECT baaki_delete_expense_comment($1)`, [id]));
    const row = await rowById(id);
    expect(row.deleted_at).not.toBeNull();
    expect(await visibleTo(P(2))).toBe(0);
  });

  it("T8 a non-admin member cannot delete someone else's", async () => {
    const id = await addComment(P(1), 'not yours to remove');
    const msg = await expectDenied(
      as(P(2), () => client.query(`SELECT baaki_delete_expense_comment($1)`, [id])),
    );
    expect(msg).toMatch(/CANNOT_DELETE/);
    expect(await visibleTo(P(2))).toBe(1);
  });

  it("T9 an admin deletes anyone's, and it records who removed it", async () => {
    const id = await addComment(P(1), 'admin will remove this');
    await as(P(0), () => client.query(`SELECT baaki_delete_expense_comment($1)`, [id]));
    const row = await rowById(id);
    expect(row.deleted_at).not.toBeNull();
    expect(String(row.deleted_by)).toBe(g.memberIds[0]);
    expect(await visibleTo(P(1))).toBe(0);
  });

  it('T10 any member flags/reports; the first flagger is kept', async () => {
    const id = await addComment(P(1), 'questionable');
    await as(P(2), () => client.query(`SELECT baaki_flag_expense_comment($1, true)`, [id]));
    let row = await rowById(id);
    expect(row.flagged_at).not.toBeNull();
    expect(String(row.flagged_by)).toBe(g.memberIds[2]);
    // A second flag does not overwrite the first flagger.
    await as(P(0), () => client.query(`SELECT baaki_flag_expense_comment($1, true)`, [id]));
    row = await rowById(id);
    expect(String(row.flagged_by)).toBe(g.memberIds[2]);
  });

  it('T11 a non-admin cannot clear a flag', async () => {
    const id = await addComment(P(1), 'reported');
    await as(P(2), () => client.query(`SELECT baaki_flag_expense_comment($1, true)`, [id]));
    const msg = await expectDenied(
      as(P(1), () => client.query(`SELECT baaki_flag_expense_comment($1, false)`, [id])),
    );
    expect(msg).toMatch(/ADMIN_ONLY/);
  });

  it('T12 an admin resolves a report', async () => {
    const id = await addComment(P(1), 'reported then resolved');
    await as(P(2), () => client.query(`SELECT baaki_flag_expense_comment($1, true)`, [id]));
    await as(P(0), () => client.query(`SELECT baaki_flag_expense_comment($1, false)`, [id]));
    const row = await rowById(id);
    expect(row.flagged_at).toBeNull();
    expect(row.flagged_by).toBeNull();
  });

  it('T13 re-adding the same id is idempotent (one row)', async () => {
    const id = randomUUID();
    await addComment(P(1), 'once', id);
    await addComment(P(1), 'twice', id);
    const n = await client
      .query(`SELECT count(*)::int AS n FROM expense_comments WHERE id = $1`, [id])
      .then((r) => r.rows[0].n as number);
    expect(n).toBe(1);
  });

  it('T14 a comment cannot target an expense in another group', async () => {
    const other = await seedGroup(client, { memberCount: 2, name: 'Other' });
    const { expenseId: otherExpense } = await addEqualSplitExpense(client, {
      groupId: other.groupId,
      payers: { [other.memberIds[0] as string]: 1000n },
      participants: other.memberIds,
      amount: 1000n,
    });
    // m1 is in g, not in `other` — claims g's group but a foreign expense.
    const msg = await expectDenied(
      as(P(1), () =>
        client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
          g.groupId,
          otherExpense,
          randomUUID(),
          'cross-group',
        ]),
      ),
    );
    expect(msg).toMatch(/UNKNOWN_EXPENSE/);
  });

  it('T15 an empty comment is refused', async () => {
    const msg = await expectDenied(
      as(P(1), () =>
        client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
          g.groupId,
          expenseId,
          randomUUID(),
          '   ',
        ]),
      ),
    );
    expect(msg).toMatch(/EMPTY_COMMENT/);
  });

  it('T17 a comment id from another group is not a replay — it is a conflict', async () => {
    const other = await seedGroup(client, { memberCount: 2, name: 'Cross-scope A' });
    const { expenseId: otherExpense } = await addEqualSplitExpense(client, {
      groupId: other.groupId,
      payers: { [other.memberIds[0] as string]: 1000n },
      participants: other.memberIds,
      amount: 1000n,
    });
    const id = randomUUID();
    // A genuine comment in `other`, owned by other.profileIds[0].
    await as(other.profileIds[0] as string, () =>
      client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
        other.groupId,
        otherExpense,
        id,
        'belongs to the other group',
      ]),
    );
    // A member of `g` reuses that same id, targeting g's own group/expense.
    // Before the fix this silently returned `id` (an existence oracle) with
    // no row inserted into g; now it is a clean conflict.
    const msg = await expectDenied(
      as(P(1), () =>
        client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
          g.groupId,
          expenseId,
          id,
          'trying to reuse a foreign id',
        ]),
      ),
    );
    expect(msg).toMatch(/COMMENT_ID_CONFLICT/);
    // And the original, untouched.
    const row = await rowById(id);
    expect(String(row.author_member_id)).toBe(other.memberIds[0]);
  });

  it('T18 a comment id already used on a different expense in the same group is a conflict', async () => {
    const { expenseId: secondExpense } = await addEqualSplitExpense(client, {
      groupId: g.groupId,
      payers: { [g.memberIds[0] as string]: 1000n },
      participants: g.memberIds,
      amount: 1000n,
      description: 'A second bill',
    });
    const id = await addComment(P(1), 'on the first expense');
    const msg = await expectDenied(
      as(P(1), () =>
        client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
          g.groupId,
          secondExpense,
          id,
          'same group, different expense',
        ]),
      ),
    );
    expect(msg).toMatch(/COMMENT_ID_CONFLICT/);
  });

  it('T19 a comment id already used by a different author on the same expense is a conflict', async () => {
    const id = await addComment(P(1), "P1's comment");
    const msg = await expectDenied(
      as(P(2), () =>
        client.query(`SELECT baaki_add_expense_comment($1, $2, $3, $4)`, [
          g.groupId,
          expenseId,
          id,
          'P2 tries to reuse it',
        ]),
      ),
    );
    expect(msg).toMatch(/COMMENT_ID_CONFLICT/);
    const row = await rowById(id);
    expect(String(row.author_member_id)).toBe(g.memberIds[1]);
  });

  it('T16 the table is not directly writable — RPCs are the only way in', async () => {
    const id = await addComment(P(1), 'legit');
    // Direct INSERT forging an author.
    await expectDenied(
      as(P(2), () =>
        client.query(
          `INSERT INTO expense_comments (id, group_id, expense_id, author_member_id, body)
           VALUES ($1, $2, $3, $4, 'forged')`,
          [randomUUID(), g.groupId, expenseId, g.memberIds[0]],
        ),
      ),
    );
    // Direct UPDATE bypassing the author check.
    await expectDenied(
      as(P(2), () =>
        client.query(`UPDATE expense_comments SET body = 'hijacked' WHERE id = $1`, [id]),
      ),
    );
    // Direct DELETE bypassing the role matrix.
    await expectDenied(
      as(P(2), () => client.query(`DELETE FROM expense_comments WHERE id = $1`, [id])),
    );
  });
});
