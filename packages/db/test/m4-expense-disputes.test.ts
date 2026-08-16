/**
 * Declining an expense somebody else added.
 *
 * The first block is the whole design, and it is a negative: a decline must not
 * move a balance. The obvious implementation — take me out of the split — is
 * the one thing that must never exist, because a share you can remove
 * unilaterally is a debt you can delete, and this ledger is worth exactly as
 * much as that is impossible.
 *
 * What a decline does instead is make the disagreement visible and tell the
 * person who entered it. The numbers change when somebody edits the expense,
 * which anybody in the group has always been able to do — membership, not
 * authorship, is what `expense_versions_insert` checks, because the person who
 * spots that dinner was ₹1,800 is usually not the person who typed ₹1,300.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, big, connect, readBalances, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

interface Scene {
  groupId: string;
  expenseId: string;
  profileIds: string[];
  memberIds: string[];
}

/** Asha (admin, member 0) enters a ₹300 dinner split three ways. */
async function seedExpense(): Promise<Scene> {
  const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 3 });
  const { expenseId } = await addEqualSplitExpense(client, {
    groupId,
    payers: { [memberIds[0] ?? '']: 30000n },
    participants: memberIds,
    amount: 30000n,
    description: 'Dinner',
  });
  return { groupId, expenseId, profileIds, memberIds };
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

const dispute = (profileId: string, expenseId: string, reason?: string): Promise<string> =>
  asUser(profileId, async () => {
    const { rows } = await client.query(`SELECT baaki_dispute_expense($1, $2) AS id`, [
      expenseId,
      reason ?? null,
    ]);
    return String(rows[0]?.id);
  });

const disputesOn = async (expenseId: string): Promise<Record<string, unknown>[]> => {
  const { rows } = await client.query(
    `SELECT * FROM expense_disputes WHERE expense_id = $1 ORDER BY created_at`,
    [expenseId],
  );
  return rows as Record<string, unknown>[];
};

const inboxCount = async (profileId: string, kind: string): Promise<number> => {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE profile_id = $1 AND kind = $2`,
    [profileId, kind],
  );
  return Number(rows[0]?.n);
};

describe('a decline changes nothing about the money', () => {
  it('leaves every balance exactly where it was', async () => {
    // If this test can ever be made to fail, the ledger is worthless.
    const scene = await seedExpense();
    const before = await readBalances(client, scene.groupId);
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I was not there');
    const after = await readBalances(client, scene.groupId);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it('leaves the disputer still owing their share', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    const balances = await readBalances(client, scene.groupId);
    expect(balances.get(scene.memberIds[1] ?? '')).toBe(-10000n);
  });

  it('does not touch the expense or its versions', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS versions FROM expense_versions WHERE expense_id = $1`,
      [scene.expenseId],
    );
    expect(rows[0]?.versions).toBe(1);
  });
});

describe('raising one', () => {
  it('records who said so and why', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I left before the dessert');
    const [row] = await disputesOn(scene.expenseId);
    expect(row?.member_id).toBe(scene.memberIds[1]);
    expect(row?.reason).toBe('I left before the dessert');
    expect(row?.status).toBe('open');
  });

  it('does not insist on a reason', async () => {
    // Making somebody justify themselves before they can say "this is wrong" is
    // how a feature goes unused.
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    const [row] = await disputesOn(scene.expenseId);
    expect(row?.reason).toBeNull();
  });

  it('tells the person who entered it', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    expect(await inboxCount(scene.profileIds[0] ?? '', 'expense_disputed')).toBe(1);
  });

  it('lets two people disagree with the same expense', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    await dispute(scene.profileIds[2] ?? '', scene.expenseId);
    expect(await disputesOn(scene.expenseId)).toHaveLength(2);
  });

  it('keeps one position per person rather than a pile of complaints', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'wrong amount');
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'actually, wrong people');
    const rows = await disputesOn(scene.expenseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('actually, wrong people');
  });

  it('does not tell them twice about the same complaint', async () => {
    // A retried call is a retry. Two buzzes for one grievance is how people
    // learn to ignore the app.
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I was not there');
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I was not there');
    expect(await inboxCount(scene.profileIds[0] ?? '', 'expense_disputed')).toBe(1);
  });

  it('refuses somebody who is not in the group', async () => {
    const scene = await seedExpense();
    const outsiderId = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Outsider')`, [
      outsiderId,
    ]);
    await expect(dispute(outsiderId, scene.expenseId)).rejects.toThrow(/NOT_A_MEMBER|NOT_FOUND/);
  });
});

describe('answering one', () => {
  const resolve = (
    profileId: string,
    disputeId: string,
    accept: boolean,
    note?: string,
  ): Promise<unknown> =>
    asUser(profileId, () =>
      client.query(`SELECT baaki_resolve_dispute($1, $2, $3)`, [disputeId, accept, note ?? null]),
    );

  it('lets the person who entered the expense accept it', async () => {
    const scene = await seedExpense();
    const disputeId = await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    await resolve(scene.profileIds[0] ?? '', disputeId, true, 'You are right, fixing it');
    const [row] = await disputesOn(scene.expenseId);
    expect(row?.status).toBe('resolved');
    expect(row?.resolution_note).toBe('You are right, fixing it');
  });

  it('lets them reject it, with the reason recorded', async () => {
    const scene = await seedExpense();
    const disputeId = await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    await resolve(scene.profileIds[0] ?? '', disputeId, false, 'You had the biryani');
    const [row] = await disputesOn(scene.expenseId);
    expect(row?.status).toBe('rejected');
  });

  it('refuses to let the disputer rule on their own complaint', async () => {
    // In either direction. "I declined it, so I closed it" is not a resolution.
    const scene = await seedExpense();
    const disputeId = await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    await expect(resolve(scene.profileIds[1] ?? '', disputeId, true)).rejects.toThrow(
      /NOT_YOURS_TO_RESOLVE/,
    );
  });

  it('refuses an unrelated member who is not an admin', async () => {
    const scene = await seedExpense();
    const disputeId = await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    await expect(resolve(scene.profileIds[2] ?? '', disputeId, false)).rejects.toThrow(
      /NOT_YOURS_TO_RESOLVE/,
    );
  });

  it('tells the disputer either way', async () => {
    const scene = await seedExpense();
    const disputeId = await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    await resolve(scene.profileIds[0] ?? '', disputeId, false, 'You had the biryani');
    expect(await inboxCount(scene.profileIds[1] ?? '', 'expense_dispute_resolved')).toBe(1);
  });

  it('lets somebody raise it again after a rejection', async () => {
    const scene = await seedExpense();
    const first = await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I was not there');
    await resolve(scene.profileIds[0] ?? '', first, false);
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I really was not there');
    const [row] = await disputesOn(scene.expenseId);
    expect(row?.status).toBe('open');
    // A new complaint, so the author hears about it again.
    expect(await inboxCount(scene.profileIds[0] ?? '', 'expense_disputed')).toBe(2);
  });
});

describe('withdrawing one', () => {
  it('lets somebody take it back', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    await asUser(scene.profileIds[1] ?? '', () =>
      client.query(`SELECT baaki_withdraw_dispute($1)`, [scene.expenseId]),
    );
    const [row] = await disputesOn(scene.expenseId);
    expect(row?.status).toBe('withdrawn');
  });

  it('will not let somebody withdraw a complaint that is not theirs', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    await expect(
      asUser(scene.profileIds[2] ?? '', () =>
        client.query(`SELECT baaki_withdraw_dispute($1)`, [scene.expenseId]),
      ),
    ).rejects.toThrow(/NOT_YOUR_DISPUTE/);
  });
});

describe('an edit answers it by itself', () => {
  it('closes every open dispute, because the thing complained about is gone', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I was not there');
    await dispute(scene.profileIds[2] ?? '', scene.expenseId);

    // Anybody in the group can correct an expense — membership, not authorship.
    await addVersion(scene, scene.memberIds[1] ?? '', 20000n, [
      scene.memberIds[0] ?? '',
      scene.memberIds[2] ?? '',
    ]);

    const rows = await disputesOn(scene.expenseId);
    expect(rows.map((row) => row.status)).toEqual(['resolved', 'resolved']);
    expect(rows[0]?.resolution_note).toBe('The expense was edited');
  });

  it('and the balances move only then', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I was not there');
    const duringDispute = await readBalances(client, scene.groupId);
    expect(duringDispute.get(scene.memberIds[1] ?? '')).toBe(-10000n);

    await addVersion(scene, scene.memberIds[1] ?? '', 30000n, [
      scene.memberIds[0] ?? '',
      scene.memberIds[2] ?? '',
    ]);

    const after = await readBalances(client, scene.groupId);
    expect(after.get(scene.memberIds[1] ?? '') ?? 0n).toBe(0n);
  });
});

/** A correction: a second version with a different set of participants. */
async function addVersion(
  scene: Scene,
  authorMemberId: string,
  amount: bigint,
  participants: string[],
): Promise<void> {
  const versionId = randomUUID();
  const share = amount / BigInt(participants.length);
  const remainder = amount - share * BigInt(participants.length);
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO expense_versions
         (id, expense_id, version_no, author_member_id, description, expense_date,
          currency, amount, split_type, split_params)
       VALUES ($1, $2, 2, $3, 'Dinner', '2026-03-01', 'INR', $4, 'equal', '{"kind":"equal"}'::jsonb)`,
      [versionId, scene.expenseId, authorMemberId, amount.toString()],
    );
    await client.query(
      `INSERT INTO expense_payers (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), versionId, scene.memberIds[0], amount.toString()],
    );
    for (const [index, memberId] of participants.entries()) {
      const value = index === participants.length - 1 ? share + remainder : share;
      await client.query(
        `INSERT INTO expense_shares (id, expense_version_id, member_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), versionId, memberId, value.toString()],
      );
    }
    await client.query(`UPDATE expenses SET current_version_id = $1 WHERE id = $2`, [
      versionId,
      scene.expenseId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describe('who can see one', () => {
  it('is the group, and nobody else', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId, 'I was not there');

    const outsiderId = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Outsider')`, [
      outsiderId,
    ]);

    const mine = await asUser(scene.profileIds[2] ?? '', async () => {
      const { rows } = await client.query(`SELECT id FROM expense_disputes WHERE expense_id = $1`, [
        scene.expenseId,
      ]);
      return rows.length;
    });
    const theirs = await asUser(outsiderId, async () => {
      const { rows } = await client.query(`SELECT id FROM expense_disputes WHERE expense_id = $1`, [
        scene.expenseId,
      ]);
      return rows.length;
    });

    expect(mine).toBe(1);
    expect(theirs).toBe(0);
  });

  it('cannot be filed in somebody else’s name', async () => {
    // The table is read-only to clients; every write goes through an RPC that
    // works out who the caller is.
    const scene = await seedExpense();
    await expect(
      asUser(scene.profileIds[1] ?? '', () =>
        client.query(
          `INSERT INTO expense_disputes (expense_id, member_id, status) VALUES ($1, $2, 'open')`,
          [scene.expenseId, scene.memberIds[2]],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});

describe('the numbers still add up', () => {
  it('leaves the group summing to zero, disputed or not', async () => {
    const scene = await seedExpense();
    await dispute(scene.profileIds[1] ?? '', scene.expenseId);
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(balance), 0) AS total FROM group_balances WHERE group_id = $1`,
      [scene.groupId],
    );
    expect(big(rows[0]?.total)).toBe(0n);
  });
});
