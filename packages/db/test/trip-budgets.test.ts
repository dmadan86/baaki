/**
 * Trip budgets, at the trust boundary.
 *
 * The one thing worth proving in the database rather than the app: a private
 * personal budget is never returned to anybody but its owner, and the overall
 * budget only an admin can move. Everything else about budgets is arithmetic,
 * and lives in @waves/core's unit tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied, seedGroup, type SeededGroup } from './helpers';

let client: Client;
let group: SeededGroup;

beforeAll(async () => {
  client = await connect();
  // profile 0 = admin, 1 and 2 = members.
  group = await seedGroup(client, { memberCount: 3, name: 'Goa budgets' });
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query(`DELETE FROM trip_member_budgets WHERE group_id = $1`, [group.groupId]);
  await client.query(
    `UPDATE groups SET budget_minor = NULL, budget_currency = NULL WHERE id = $1`,
    [group.groupId],
  );
});

/** Run committed as a signed-in profile, the way an RLS read really happens. */
async function as<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query('SET ROLE authenticated');
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
  }
}

const visibleBudgetMembers = async (profileId: string): Promise<string[]> =>
  as(profileId, async () => {
    const { rows } = await client.query(
      `SELECT member_id FROM trip_member_budgets WHERE group_id = $1`,
      [group.groupId],
    );
    return rows.map((row) => String(row.member_id));
  });

describe('a personal budget is private until shared', () => {
  it('hides one member’s private budget from a co-member, but not from its owner', async () => {
    const [, m1] = group.memberIds;
    await as(group.profileIds[1] as string, async () => {
      await client.query(`SELECT waves_set_my_trip_budget($1, 500000, NULL, 'private')`, [
        group.groupId,
      ]);
    });

    // The owner sees their own row.
    expect(await visibleBudgetMembers(group.profileIds[1] as string)).toContain(m1);
    // A co-member does not — the row matches no SELECT clause and never ships.
    expect(await visibleBudgetMembers(group.profileIds[2] as string)).not.toContain(m1);
    // Not even the admin sees a private budget: private means private.
    expect(await visibleBudgetMembers(group.profileIds[0] as string)).not.toContain(m1);
  });

  it('shows it to the whole group once shared', async () => {
    const [, m1] = group.memberIds;
    await as(group.profileIds[1] as string, async () => {
      await client.query(`SELECT waves_set_my_trip_budget($1, 500000, NULL, 'group')`, [
        group.groupId,
      ]);
    });
    expect(await visibleBudgetMembers(group.profileIds[2] as string)).toContain(m1);
  });

  it('flipping back to private hides it again', async () => {
    const [, m1] = group.memberIds;
    await as(group.profileIds[1] as string, async () => {
      await client.query(`SELECT waves_set_my_trip_budget($1, 500000, NULL, 'group')`, [
        group.groupId,
      ]);
      // Upsert on the same member — one row, not two.
      await client.query(`SELECT waves_set_my_trip_budget($1, 700000, NULL, 'private')`, [
        group.groupId,
      ]);
    });
    const { rows } = await client.query(
      `SELECT count(*)::int AS n, max(amount_minor)::text AS amount
         FROM trip_member_budgets WHERE member_id = $1`,
      [m1],
    );
    expect(rows[0].n).toBe(1);
    expect(rows[0].amount).toBe('700000');
    expect(await visibleBudgetMembers(group.profileIds[2] as string)).not.toContain(m1);
  });
});

describe('writing a personal budget', () => {
  it('cannot be written directly — only the RPC sets member_id', async () => {
    await as(group.profileIds[1] as string, async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO trip_member_budgets (group_id, member_id, amount_minor)
           VALUES ($1, $2, 100000)`,
          [group.groupId, group.memberIds[0]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses a negative budget', async () => {
    await as(group.profileIds[1] as string, async () => {
      const message = await expectDenied(
        client.query(`SELECT waves_set_my_trip_budget($1, -1, NULL, 'private')`, [group.groupId]),
      );
      expect(message).toMatch(/INVALID_AMOUNT/);
    });
  });
});

describe('the overall budget is the admin’s', () => {
  it('lets an admin set and clear it', async () => {
    await as(group.profileIds[0] as string, async () => {
      await client.query(`SELECT waves_set_group_budget($1, 5000000, 'INR')`, [group.groupId]);
    });
    let { rows } = await client.query(
      `SELECT budget_minor::text AS m, budget_currency AS c FROM groups WHERE id = $1`,
      [group.groupId],
    );
    expect(rows[0].m).toBe('5000000');
    expect(rows[0].c).toBe('INR');

    await as(group.profileIds[0] as string, async () => {
      await client.query(`SELECT waves_set_group_budget($1, NULL, NULL)`, [group.groupId]);
    });
    ({ rows } = await client.query(
      `SELECT budget_minor AS m, budget_currency AS c FROM groups WHERE id = $1`,
      [group.groupId],
    ));
    expect(rows[0].m).toBeNull();
    expect(rows[0].c).toBeNull();
  });

  it('refuses a plain member', async () => {
    await as(group.profileIds[1] as string, async () => {
      const message = await expectDenied(
        client.query(`SELECT waves_set_group_budget($1, 5000000, 'INR')`, [group.groupId]),
      );
      expect(message).toMatch(/NOT_AN_ADMIN/);
    });
  });
});

describe('clearing a personal budget is a soft delete (so it syncs)', () => {
  it('marks the row deleted and bumps the seq rather than dropping it', async () => {
    const member = group.profileIds[1] as string;
    const memberId = group.memberIds[1] as string;
    const seqAfterSet = await as(member, async () => {
      await client.query(`SELECT waves_set_my_trip_budget($1, 500000, NULL, 'private')`, [
        group.groupId,
      ]);
      const { rows } = await client.query(
        `SELECT updated_seq FROM trip_member_budgets WHERE member_id = $1`,
        [memberId],
      );
      await client.query(`SELECT waves_clear_my_trip_budget($1)`, [group.groupId]);
      return Number(rows[0].updated_seq);
    });
    const { rows } = await client.query(
      `SELECT deleted_at, updated_seq FROM trip_member_budgets WHERE member_id = $1`,
      [memberId],
    );
    // The tombstone stays so a second device learns the budget is gone, and the
    // clear must bump the seq past the set so that pull actually carries it.
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(seqAfterSet).toBeGreaterThan(0);
    expect(Number(rows[0].updated_seq)).toBeGreaterThan(seqAfterSet);
  });

  it('revives the one row when the budget is set again, not a second row', async () => {
    const member = group.profileIds[1] as string;
    const memberId = group.memberIds[1] as string;
    await as(member, async () => {
      await client.query(`SELECT waves_set_my_trip_budget($1, 500000, NULL, 'private')`, [
        group.groupId,
      ]);
      await client.query(`SELECT waves_clear_my_trip_budget($1)`, [group.groupId]);
      await client.query(`SELECT waves_set_my_trip_budget($1, 700000, NULL, 'private')`, [
        group.groupId,
      ]);
    });
    const { rows } = await client.query(
      `SELECT count(*)::int AS n, max(amount_minor)::text AS amount, bool_or(deleted_at IS NULL) AS live
         FROM trip_member_budgets WHERE member_id = $1`,
      [memberId],
    );
    expect(rows[0].n).toBe(1); // the UNIQUE(member_id) row, raised — not a collision
    expect(rows[0].amount).toBe('700000');
    expect(rows[0].live).toBe(true);
  });
});
