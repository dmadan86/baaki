/**
 * The trip plan: shared, editable by anybody in the group, and never money.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied, seedGroup, type SeededGroup } from './helpers';

let client: Client;
let group: SeededGroup;

beforeAll(async () => {
  client = await connect();
  group = await seedGroup(client, { memberCount: 2, name: 'Goa' });
  await client.query(
    `UPDATE groups SET start_date = '2026-03-14', end_date = '2026-03-17' WHERE id = $1`,
    [group.groupId],
  );
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query(`DELETE FROM trip_plan_items WHERE group_id = $1`, [group.groupId]);
});

/**
 * Run as somebody, and **commit**. Not wrapped in a rolled-back transaction:
 * half these tests assert on what is still there afterwards, and a rollback
 * would make every one of them pass against an empty table.
 */
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

/** starts_at, note, category, planned_minor, currency, item_id — all optional. */
const add = (title: string, day = '2026-03-14') =>
  client.query(`SELECT baaki_add_plan_item($1, $2, $3, NULL, NULL, NULL, NULL, NULL, NULL) AS id`, [
    group.groupId,
    day,
    title,
  ]);

describe('adding to the plan', () => {
  it('records who added it, from the session rather than the argument', async () => {
    // "Who added this" is not a question a client answers about itself — the
    // same rule as actor_member_id on the activity log.
    const id = await as(group.profileIds[0] as string, async () => {
      const { rows } = await add('Dudhsagar falls');
      return String(rows[0].id);
    });
    const { rows } = await client.query(
      `SELECT created_by, title, currency FROM trip_plan_items WHERE id = $1`,
      [id],
    );
    expect(rows[0].created_by).toBe(group.memberIds[0]);
    expect(rows[0].title).toBe('Dudhsagar falls');
    // Falls back to the group's currency rather than a hardcoded rupee.
    expect(rows[0].currency).toBe('INR');
  });

  it('refuses an item with no name', async () => {
    await as(group.profileIds[0] as string, async () => {
      const message = await expectDenied(add('   '));
      expect(message).toMatch(/INVALID_TITLE/);
    });
  });

  it('refuses somebody who is not in the group', async () => {
    const outsider = randomUUID();
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Mallory', 'INR')`,
      [outsider],
    );
    await as(outsider, async () => {
      const message = await expectDenied(add('Sneak in'));
      expect(message).toMatch(/NOT_A_MEMBER/);
    });
  });

  it('returns the same item when a create is replayed', async () => {
    // A planner is used on a phone with one bar of signal by definition.
    const itemId = randomUUID();
    const call = `SELECT baaki_add_plan_item($1, $2, 'Beach', NULL, NULL, NULL, NULL, NULL, $3) AS id`;
    await as(group.profileIds[0] as string, async () => {
      const first = await client.query(call, [group.groupId, '2026-03-15', itemId]);
      const second = await client.query(call, [group.groupId, '2026-03-15', itemId]);
      expect(String(second.rows[0].id)).toBe(String(first.rows[0].id));
    });
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM trip_plan_items WHERE id = $1`,
      [itemId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('numbers each day’s items from zero independently', async () => {
    await as(group.profileIds[0] as string, async () => {
      await add('One', '2026-03-14');
      await add('Two', '2026-03-14');
      await add('Other day', '2026-03-15');
    });
    const { rows } = await client.query(
      `SELECT day::text, position FROM trip_plan_items WHERE group_id = $1 ORDER BY day, position`,
      [group.groupId],
    );
    expect(rows.map((row) => row.position)).toEqual([0, 1, 0]);
  });

  it('refuses a negative budget but allows a free one', async () => {
    await as(group.profileIds[0] as string, async () => {
      const message = await expectDenied(
        client.query(
          `SELECT baaki_add_plan_item($1, '2026-03-14', 'Bad', NULL, NULL, NULL, -100, NULL, NULL)`,
          [group.groupId],
        ),
      );
      expect(message).toMatch(/trip_plan_items_planned_sane|violates/i);

      // "The beach is free" is a real thing to plan.
      await client.query(
        `SELECT baaki_add_plan_item($1, '2026-03-14', 'Beach', NULL, NULL, NULL, 0, NULL, NULL)`,
        [group.groupId],
      );
    });
  });
});

describe('changing the plan', () => {
  async function seedItem(): Promise<string> {
    const { rows } = await client.query(
      `SELECT baaki_add_plan_item($1, '2026-03-14', 'Falls', NULL, 'take cash', NULL, 200000, NULL, NULL) AS id`,
      [group.groupId],
    );
    return String(rows[0].id);
  }

  it('lets anybody in the group edit, not only whoever added it', async () => {
    // A shared plan only its author can edit goes stale the moment they put
    // their phone down.
    const id = await as(group.profileIds[0] as string, seedItem);
    await as(group.profileIds[1] as string, async () => {
      await client.query(`SELECT baaki_update_plan_item($1, NULL, NULL, 'Dudhsagar falls')`, [id]);
    });
    const { rows } = await client.query(`SELECT title FROM trip_plan_items WHERE id = $1`, [id]);
    expect(rows[0].title).toBe('Dudhsagar falls');
  });

  it('leaves untouched fields alone', async () => {
    const id = await as(group.profileIds[0] as string, seedItem);
    await as(group.profileIds[0] as string, async () => {
      await client.query(`SELECT baaki_update_plan_item($1, '2026-03-16')`, [id]);
    });
    const { rows } = await client.query(
      `SELECT day::text AS day, note, planned_minor FROM trip_plan_items WHERE id = $1`,
      [id],
    );
    expect(rows[0].day).toBe('2026-03-16');
    expect(rows[0].note).toBe('take cash');
    expect(String(rows[0].planned_minor)).toBe('200000');
  });

  it('clears a field only when asked to, because NULL cannot mean two things', async () => {
    const id = await as(group.profileIds[0] as string, seedItem);
    await as(group.profileIds[0] as string, async () => {
      await client.query(
        `SELECT baaki_update_plan_item($1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                                       ARRAY['note','planned_minor'])`,
        [id],
      );
    });
    const { rows } = await client.query(
      `SELECT note, planned_minor FROM trip_plan_items WHERE id = $1`,
      [id],
    );
    expect(rows[0].note).toBeNull();
    expect(rows[0].planned_minor).toBeNull();
  });

  it('ticks off and un-ticks', async () => {
    const id = await as(group.profileIds[0] as string, seedItem);
    await as(group.profileIds[0] as string, async () => {
      await client.query(
        `SELECT baaki_update_plan_item($1, NULL, NULL, NULL, NULL, NULL, NULL, true)`,
        [id],
      );
    });
    let { rows } = await client.query(`SELECT done_at FROM trip_plan_items WHERE id = $1`, [id]);
    expect(rows[0].done_at).not.toBeNull();

    await as(group.profileIds[0] as string, async () => {
      await client.query(
        `SELECT baaki_update_plan_item($1, NULL, NULL, NULL, NULL, NULL, NULL, false)`,
        [id],
      );
    });
    ({ rows } = await client.query(`SELECT done_at FROM trip_plan_items WHERE id = $1`, [id]));
    expect(rows[0].done_at).toBeNull();
  });

  it('refuses to link an expense from another group', async () => {
    // Otherwise a plan item could point at a stranger's expense and leak its
    // description through the join the app makes.
    const id = await as(group.profileIds[0] as string, seedItem);

    // `RESET ROLE` puts the role back but leaves the JWT claim set, and
    // `baaki_apply_expense` now checks its caller — so seeding another group's
    // expense while still "logged in" as somebody outside it is refused.
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
    const other = await seedGroup(client, { memberCount: 1, name: 'Elsewhere' });
    const { rows: made } = await client.query(
      `SELECT baaki_apply_expense($1, NULL, $2, 'Theirs', NULL, current_date, 'INR', 1000,
        'equal', '{"kind":"equal"}'::jsonb, $3::jsonb, $4::jsonb, $5) AS out`,
      [
        other.groupId,
        other.memberIds[0],
        JSON.stringify([{ memberId: other.memberIds[0], amount: '1000' }]),
        JSON.stringify([{ memberId: other.memberIds[0], amount: '1000' }]),
        randomUUID(),
      ],
    );
    const foreignExpense = (made[0].out as { expenseId: string }).expenseId;

    await as(group.profileIds[0] as string, async () => {
      const message = await expectDenied(
        client.query(
          `SELECT baaki_update_plan_item($1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2)`,
          [id, foreignExpense],
        ),
      );
      expect(message).toMatch(/UNKNOWN_EXPENSE/);
    });
  });

  it('refuses an outsider editing or removing', async () => {
    const id = await as(group.profileIds[0] as string, seedItem);
    const outsider = randomUUID();
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Mallory', 'INR')`,
      [outsider],
    );
    await as(outsider, async () => {
      expect(
        await expectDenied(
          client.query(`SELECT baaki_update_plan_item($1, NULL, NULL, 'Mine now')`, [id]),
        ),
      ).toMatch(/NOT_A_MEMBER/);
      expect(await expectDenied(client.query(`SELECT baaki_remove_plan_item($1)`, [id]))).toMatch(
        /NOT_A_MEMBER/,
      );
    });
  });

  it('removes as a soft delete so the tombstone can sync, and twice is fine', async () => {
    const id = await as(group.profileIds[0] as string, seedItem);
    const seqAfterFirst = await as(group.profileIds[0] as string, async () => {
      await client.query(`SELECT baaki_remove_plan_item($1)`, [id]);
      const { rows } = await client.query(`SELECT updated_seq FROM trip_plan_items WHERE id = $1`, [
        id,
      ]);
      const seq = Number(rows[0].updated_seq);
      // Removing again must be a no-op — the RPC guards on `deleted_at IS NULL`,
      // so a second call cannot re-stamp the seq and churn every device's pull.
      await client.query(`SELECT baaki_remove_plan_item($1)`, [id]);
      return seq;
    });
    // The row stays, marked deleted, so a seq-based pull carries the removal to
    // other devices; a live read (deleted_at IS NULL) sees nothing.
    const { rows } = await client.query(
      `SELECT deleted_at, updated_seq FROM trip_plan_items WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(seqAfterFirst).toBeGreaterThan(0);
    expect(Number(rows[0].updated_seq)).toBe(seqAfterFirst); // unchanged by the 2nd remove
  });
});

describe('a plan is not a ledger', () => {
  it('changes nobody’s balance', async () => {
    // The reason a plan item is its own table rather than an expense with a
    // flag: an expense that has not happened would show up in balances, in
    // exports and in simplification, and all three would be wrong.
    const before = await client.query(
      `SELECT coalesce(sum(balance), 0)::text AS total FROM group_balances WHERE group_id = $1`,
      [group.groupId],
    );
    await as(group.profileIds[0] as string, async () => {
      await client.query(
        `SELECT baaki_add_plan_item($1, '2026-03-14', 'Hotel', NULL, NULL, NULL, 900000, NULL, NULL)`,
        [group.groupId],
      );
    });
    const after = await client.query(
      `SELECT coalesce(sum(balance), 0)::text AS total FROM group_balances WHERE group_id = $1`,
      [group.groupId],
    );
    expect(after.rows[0].total).toBe(before.rows[0].total);
  });

  it('is not writable directly, so created_by cannot be forged', async () => {
    await as(group.profileIds[1] as string, async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO trip_plan_items (group_id, day, title, created_by)
           VALUES ($1, '2026-03-14', 'Forged', $2)`,
          [group.groupId, group.memberIds[0]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('is readable by everybody in the group', async () => {
    await as(group.profileIds[0] as string, async () => {
      await add('Shared');
    });
    const seen = await as(group.profileIds[1] as string, async () => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM trip_plan_items WHERE group_id = $1`,
        [group.groupId],
      );
      return rows[0].n as number;
    });
    expect(seen).toBe(1);
  });
});
