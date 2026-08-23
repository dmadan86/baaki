/**
 * M1: the operations the online ledger performs, each of which has to be both
 * authorized and atomic. These run as the `authenticated` role with a JWT claim
 * set, exactly as PostgREST would call them.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import {
  addEqualSplitExpense,
  big,
  connect,
  expectDenied,
  readBalances,
  seedGroup,
} from './helpers.js';

let client: Client;

/** Create a profile the way the auth.users trigger would. */
async function createProfile(name: string): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, $2)`, [id, name]);
  return id;
}

/**
 * Run a statement as a signed-in user. Unlike the RLS suite these are not
 * rolled back — the RPCs are what we are testing, so their effects must land.
 */
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

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

describe('baaki_create_group', () => {
  it('creates the group and makes the caller its admin, in one operation', async () => {
    const profileId = await createProfile('Asha');

    const groupId = await asUser(profileId, async () => {
      const result = await client.query(
        `SELECT baaki_create_group('Goa trip', 'trip', 'INR', '🏖️', true) AS id`,
      );
      return String(result.rows[0]?.id);
    });

    const group = await client.query(
      `SELECT name, type, simplify_debts FROM groups WHERE id = $1`,
      [groupId],
    );
    expect(group.rows[0]?.name).toBe('Goa trip');
    expect(group.rows[0]?.type).toBe('trip');

    const member = await client.query(
      `SELECT role FROM group_members WHERE group_id = $1 AND profile_id = $2`,
      [groupId, profileId],
    );
    expect(member.rows[0]?.role).toBe('admin');

    const activity = await client.query(
      `SELECT verb FROM activity_log WHERE group_id = $1 AND object_type = 'group'`,
      [groupId],
    );
    expect(activity.rows[0]?.verb).toBe('created');
  });

  it('refuses to create a group for nobody', async () => {
    expect(
      await expectDenied(
        (async () => {
          await client.query(`SET ROLE authenticated`);
          try {
            await client.query(`SELECT baaki_create_group('Orphan', 'other', 'INR', NULL, true)`);
          } finally {
            await client.query(`RESET ROLE`);
          }
        })(),
      ),
    ).toMatch(/NOT_AUTHENTICATED/);
  });

  it('accepts a blank name and stores no name at all', async () => {
    // This used to raise INVALID_NAME. Starting a group should cost one tap,
    // so a name is now optional and the app labels the group by who is in it
    // instead — see packages/db/test/groups.test.ts for the full behaviour.
    const profileId = await createProfile('Ravi');
    const groupId = await asUser(profileId, async () => {
      const result = await client.query(
        `SELECT baaki_create_group('   ', 'other', 'INR', NULL, true) AS id`,
      );
      return String(result.rows[0]?.id);
    });

    const { rows } = await client.query(`SELECT name FROM groups WHERE id = $1`, [groupId]);
    expect(rows[0]?.name).toBeNull();
  });
});

describe('soft delete and restore (ADR-004)', () => {
  it('removes an expense from balances and puts it back, logging both', async () => {
    const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const { expenseId } = await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [a]: 10000n },
      participants: [a, b],
    });

    expect((await readBalances(client, groupId)).get(b)).toBe(-5000n);

    await asUser(profileIds[0] as string, () =>
      client.query(`SELECT baaki_delete_expense($1)`, [expenseId]),
    );
    expect((await readBalances(client, groupId)).size).toBe(0);

    await asUser(profileIds[0] as string, () =>
      client.query(`SELECT baaki_restore_expense($1)`, [expenseId]),
    );
    expect((await readBalances(client, groupId)).get(b)).toBe(-5000n);

    const verbs = await client.query(
      `SELECT verb FROM activity_log WHERE object_id = $1 ORDER BY created_at`,
      [expenseId],
    );
    expect(verbs.rows.map((row) => row.verb)).toEqual(['deleted', 'restored']);
  });

  it('will not let an outsider delete somebody else’s expense', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const outsider = await createProfile('Stranger');
    const { expenseId } = await addEqualSplitExpense(client, {
      groupId,
      amount: 5000n,
      payers: { [memberIds[0] as string]: 5000n },
      participants: memberIds as string[],
    });

    expect(
      await expectDenied(
        asUser(outsider, () => client.query(`SELECT baaki_delete_expense($1)`, [expenseId])),
      ),
    ).toMatch(/NOT_A_MEMBER/);
  });
});

describe('settlement recording (ADR-007)', () => {
  it('records a settlement with per-expense allocations and moves balances on confirm', async () => {
    const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const { expenseId } = await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [a]: 10000n },
      participants: [a, b],
    });

    const settlementId = await asUser(profileIds[1] as string, async () => {
      const result = await client.query(
        `SELECT baaki_record_settlement($1, $2, $3, 5000, 'cash', NULL, NULL, $4::jsonb, NULL) AS id`,
        [groupId, b, a, JSON.stringify([{ expenseId, amount: '5000' }])],
      );
      return String(result.rows[0]?.id);
    });

    // Initiated settlements do not move the headline number (TDR §3.3).
    expect((await readBalances(client, groupId)).get(b)).toBe(-5000n);

    const allocation = await client.query(
      `SELECT amount FROM settlement_allocations WHERE settlement_id = $1`,
      [settlementId],
    );
    expect(big(allocation.rows[0]?.amount)).toBe(5000n);

    // Only the payee may confirm.
    expect(
      await expectDenied(
        asUser(profileIds[1] as string, () =>
          client.query(`SELECT baaki_confirm_settlement($1)`, [settlementId]),
        ),
      ),
    ).toMatch(/NOT_THE_PAYEE/);

    await asUser(profileIds[0] as string, () =>
      client.query(`SELECT baaki_confirm_settlement($1)`, [settlementId]),
    );
    expect((await readBalances(client, groupId)).size).toBe(0);
  });

  it('is idempotent: replaying the same mutation id returns the same settlement', async () => {
    const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const mutationId = randomUUID();

    const record = () =>
      asUser(profileIds[1] as string, async () => {
        const result = await client.query(
          `SELECT baaki_record_settlement($1, $2, $3, 2500, 'upi', NULL, NULL, '[]'::jsonb, $4) AS id`,
          [groupId, b, a, mutationId],
        );
        return String(result.rows[0]?.id);
      });

    const first = await record();
    const second = await record();
    expect(second).toBe(first);

    const count = await client.query(
      `SELECT count(*)::int AS count FROM settlements WHERE group_id = $1`,
      [groupId],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('refuses a settlement in a group you are not part of', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const outsider = await createProfile('Stranger');
    expect(
      await expectDenied(
        asUser(outsider, () =>
          client.query(
            `SELECT baaki_record_settlement($1, $2, $3, 100, 'cash', NULL, NULL, '[]'::jsonb, NULL)`,
            [groupId, memberIds[0], memberIds[1]],
          ),
        ),
      ),
    ).toMatch(/NOT_A_MEMBER/);
  });
});

describe('baaki_my_member_id', () => {
  it('resolves my membership and stays null for everyone else', async () => {
    const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 2 });
    const outsider = await createProfile('Stranger');

    const mine = await asUser(profileIds[0] as string, async () => {
      const result = await client.query(`SELECT baaki_my_member_id($1) AS id`, [groupId]);
      return result.rows[0]?.id as string | null;
    });
    expect(mine).toBe(memberIds[0]);

    const theirs = await asUser(outsider, async () => {
      const result = await client.query(`SELECT baaki_my_member_id($1) AS id`, [groupId]);
      return result.rows[0]?.id as string | null;
    });
    expect(theirs).toBeNull();
  });
});

describe('baaki_apply_expense (atomic write)', () => {
  const applyExpense = async (params: {
    groupId: string;
    author: string;
    amount: bigint;
    payers: { memberId: string; amount: string }[];
    shares: { memberId: string; amount: string }[];
    expenseId?: string | null;
    mutationId?: string | null;
  }) => {
    const result = await client.query(
      `SELECT baaki_apply_expense($1, $2, $3, 'Dinner', NULL, '2026-03-01', 'INR', $4,
                                  'equal', '{"kind":"equal"}'::jsonb, $5::jsonb, $6::jsonb, $7)
         AS out`,
      [
        params.groupId,
        params.expenseId ?? null,
        params.author,
        params.amount.toString(),
        JSON.stringify(params.payers),
        JSON.stringify(params.shares),
        params.mutationId ?? null,
      ],
    );
    return result.rows[0]?.out as {
      expenseId: string;
      versionId: string;
      versionNo: number;
      replayed: boolean;
    };
  };

  it('writes the version, payers and shares in one transaction', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const written = await applyExpense({
      groupId,
      author: a,
      amount: 10000n,
      payers: [{ memberId: a, amount: '10000' }],
      shares: [
        { memberId: a, amount: '5000' },
        { memberId: b, amount: '5000' },
      ],
    });

    expect(written.versionNo).toBe(1);
    expect((await readBalances(client, groupId)).get(b)).toBe(-5000n);

    const pointer = await client.query(`SELECT current_version_id FROM expenses WHERE id = $1`, [
      written.expenseId,
    ]);
    expect(pointer.rows[0]?.current_version_id).toBe(written.versionId);
  });

  it('persists a custom tag key and its denormalised display (A42)', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    // Named args so only the category fields need spelling out; the rest take
    // their defaults. `p_category` carries the tag's key, `p_category_meta` the
    // snapshot every member renders it from.
    const meta = { label: 'Client dinner', icon: 'briefcase-outline', tint: 'mint' };
    const written = await client.query(
      `SELECT baaki_apply_expense(
         p_group_id => $1, p_expense_id => NULL, p_author_member_id => $2,
         p_description => 'Dinner', p_category => 'tag-uuid', p_expense_date => '2026-03-01',
         p_currency => 'INR', p_amount => $3, p_split_type => 'equal',
         p_split_params => '{"kind":"equal"}'::jsonb,
         p_payers => $4::jsonb, p_shares => $5::jsonb, p_client_mutation_id => NULL,
         p_category_meta => $6::jsonb
       ) AS out`,
      [
        groupId,
        a,
        '10000',
        JSON.stringify([{ memberId: a, amount: '10000' }]),
        JSON.stringify([
          { memberId: a, amount: '5000' },
          { memberId: b, amount: '5000' },
        ]),
        JSON.stringify(meta),
      ],
    );
    const versionId = (written.rows[0]?.out as { versionId: string }).versionId;

    const row = await client.query(
      `SELECT category, category_meta FROM expense_versions WHERE id = $1`,
      [versionId],
    );
    expect(row.rows[0]?.category).toBe('tag-uuid');
    // The snapshot comes back verbatim, so a member without the author's catalog
    // still renders "Client dinner".
    expect(row.rows[0]?.category_meta).toEqual(meta);
  });

  it('appends a version instead of rewriting one (ADR-004)', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const first = await applyExpense({
      groupId,
      author: a,
      amount: 10000n,
      payers: [{ memberId: a, amount: '10000' }],
      shares: [
        { memberId: a, amount: '5000' },
        { memberId: b, amount: '5000' },
      ],
    });
    const second = await applyExpense({
      groupId,
      author: a,
      expenseId: first.expenseId,
      amount: 20000n,
      payers: [{ memberId: a, amount: '20000' }],
      shares: [
        { memberId: a, amount: '10000' },
        { memberId: b, amount: '10000' },
      ],
    });

    expect(second.versionNo).toBe(2);
    expect(second.expenseId).toBe(first.expenseId);
    expect((await readBalances(client, groupId)).get(b)).toBe(-10000n);

    const versions = await client.query(
      `SELECT count(*)::int AS count FROM expense_versions WHERE expense_id = $1`,
      [first.expenseId],
    );
    expect(versions.rows[0]?.count).toBe(2);
  });

  it('is idempotent on the client mutation id (ADR-005)', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const mutationId = randomUUID();
    const params = {
      groupId,
      author: a,
      amount: 6000n,
      payers: [{ memberId: a, amount: '6000' }],
      shares: [
        { memberId: a, amount: '3000' },
        { memberId: b, amount: '3000' },
      ],
      mutationId,
    };

    const first = await applyExpense(params);
    const replay = await applyExpense(params);
    expect(replay.replayed).toBe(true);
    expect(replay.versionId).toBe(first.versionId);

    const count = await client.query(
      `SELECT count(*)::int AS count FROM expense_versions WHERE expense_id = $1`,
      [first.expenseId],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('refuses members who belong to another group (ADR-013)', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const other = await seedGroup(client, { memberCount: 1 });
    const [a, b] = memberIds as [string, string];

    expect(
      await expectDenied(
        applyExpense({
          groupId,
          author: a,
          amount: 1000n,
          payers: [{ memberId: a, amount: '1000' }],
          shares: [
            { memberId: b, amount: '500' },
            { memberId: other.memberIds[0] as string, amount: '500' },
          ],
        }),
      ),
    ).toMatch(/UNKNOWN_MEMBER/);
  });

  it('still enforces the money invariant inside the transaction', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    expect(
      await expectDenied(
        applyExpense({
          groupId,
          author: a,
          amount: 10000n,
          payers: [{ memberId: a, amount: '10000' }],
          shares: [
            { memberId: a, amount: '4000' },
            { memberId: b, amount: '4000' },
          ],
        }),
      ),
    ).toMatch(/SHARE_MISMATCH/);
  });
});
