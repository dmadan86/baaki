/**
 * The trip album: shared photos, addable and removable by anybody in the group,
 * never money — the same boundaries as the plan, one table over.
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
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query(`DELETE FROM trip_photos WHERE group_id = $1`, [group.groupId]);
});

/** Run as somebody, and commit — half these tests assert on what is still there. */
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

/** path, then optional photo_id / expense_id / day / caption. */
const add = (path: string, photoId: string | null = null) =>
  client.query(`SELECT waves_add_trip_photo($1, $2, $3, NULL, NULL, NULL) AS id`, [
    group.groupId,
    path,
    photoId,
  ]);

describe('adding to the album', () => {
  it('records who added it, from the session rather than an argument', async () => {
    const id = await as(group.profileIds[0] as string, async () => {
      const { rows } = await add(`${group.groupId}/a.webp`);
      return String(rows[0].id);
    });
    const { rows } = await client.query(
      `SELECT created_by, storage_path FROM trip_photos WHERE id = $1`,
      [id],
    );
    expect(rows[0].created_by).toBe(group.memberIds[0]);
    expect(rows[0].storage_path).toBe(`${group.groupId}/a.webp`);
  });

  it('refuses a photo with no stored image', async () => {
    await as(group.profileIds[0] as string, async () => {
      const message = await expectDenied(add('   '));
      expect(message).toMatch(/INVALID_PATH/);
    });
  });

  it('refuses somebody who is not in the group', async () => {
    const outsider = randomUUID();
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Mallory', 'INR')`,
      [outsider],
    );
    await as(outsider, async () => {
      const message = await expectDenied(add(`${group.groupId}/sneak.webp`));
      expect(message).toMatch(/NOT_A_MEMBER/);
    });
  });

  it('returns the same row when a create is replayed', async () => {
    const photoId = randomUUID();
    await as(group.profileIds[0] as string, async () => {
      const first = await add(`${group.groupId}/b.webp`, photoId);
      const second = await add(`${group.groupId}/b.webp`, photoId);
      expect(String(second.rows[0].id)).toBe(String(first.rows[0].id));
    });
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM trip_photos WHERE id = $1`,
      [photoId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('refuses to pin a photo to an expense from another group', async () => {
    // Otherwise a photo could pin to a stranger's bill and leak its description
    // through the join the app makes.
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
    const other = await seedGroup(client, { memberCount: 1, name: 'Elsewhere' });
    const { rows: made } = await client.query(
      `SELECT waves_apply_expense($1, NULL, $2, 'Theirs', NULL, current_date, 'INR', 1000,
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
        client.query(`SELECT waves_add_trip_photo($1, $2, NULL, $3, NULL, NULL)`, [
          group.groupId,
          `${group.groupId}/c.webp`,
          foreignExpense,
        ]),
      );
      expect(message).toMatch(/UNKNOWN_EXPENSE/);
    });
  });
});

describe('removing from the album', () => {
  async function seedPhoto(): Promise<string> {
    const { rows } = await add(`${group.groupId}/keep.webp`);
    return String(rows[0].id);
  }

  it('lets anybody in the group remove, not only whoever added it', async () => {
    const id = await as(group.profileIds[0] as string, seedPhoto);
    await as(group.profileIds[1] as string, async () => {
      await client.query(`SELECT waves_remove_trip_photo($1)`, [id]);
    });
    const { rows } = await client.query(`SELECT deleted_at FROM trip_photos WHERE id = $1`, [id]);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('removes as a soft delete so the tombstone can sync, and twice is fine', async () => {
    const id = await as(group.profileIds[0] as string, seedPhoto);
    const seqAfterFirst = await as(group.profileIds[0] as string, async () => {
      await client.query(`SELECT waves_remove_trip_photo($1)`, [id]);
      const { rows } = await client.query(`SELECT updated_seq FROM trip_photos WHERE id = $1`, [
        id,
      ]);
      const seq = Number(rows[0].updated_seq);
      await client.query(`SELECT waves_remove_trip_photo($1)`, [id]); // no-op
      return seq;
    });
    const { rows } = await client.query(
      `SELECT deleted_at, updated_seq FROM trip_photos WHERE id = $1`,
      [id],
    );
    expect(rows[0].deleted_at).not.toBeNull();
    expect(seqAfterFirst).toBeGreaterThan(0);
    expect(Number(rows[0].updated_seq)).toBe(seqAfterFirst);
  });

  it('refuses an outsider removing', async () => {
    const id = await as(group.profileIds[0] as string, seedPhoto);
    const outsider = randomUUID();
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Mallory', 'INR')`,
      [outsider],
    );
    await as(outsider, async () => {
      expect(await expectDenied(client.query(`SELECT waves_remove_trip_photo($1)`, [id]))).toMatch(
        /NOT_A_MEMBER/,
      );
    });
  });
});

describe('an album is not a ledger', () => {
  it('is not writable directly, so created_by cannot be forged', async () => {
    await as(group.profileIds[1] as string, async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO trip_photos (group_id, storage_path, created_by)
           VALUES ($1, $2, $3)`,
          [group.groupId, `${group.groupId}/forged.webp`, group.memberIds[0]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('is readable by everybody in the group', async () => {
    await as(group.profileIds[0] as string, async () => {
      await add(`${group.groupId}/shared.webp`);
    });
    const seen = await as(group.profileIds[1] as string, async () => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM trip_photos WHERE group_id = $1`,
        [group.groupId],
      );
      return rows[0].n as number;
    });
    expect(seen).toBe(1);
  });

  it('changes nobody’s balance', async () => {
    const before = await client.query(
      `SELECT coalesce(sum(balance), 0)::text AS total FROM group_balances WHERE group_id = $1`,
      [group.groupId],
    );
    await as(group.profileIds[0] as string, async () => {
      await add(`${group.groupId}/nomoney.webp`);
    });
    const after = await client.query(
      `SELECT coalesce(sum(balance), 0)::text AS total FROM group_balances WHERE group_id = $1`,
      [group.groupId],
    );
    expect(after.rows[0].total).toBe(before.rows[0].total);
  });
});
