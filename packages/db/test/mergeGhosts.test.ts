/**
 * Merging same-person guests (TDR A38) is a union, not a replace.
 *
 * A viewer folds guests they know to be one human. When a later merge shares a
 * member with an earlier one, the two must converge onto a single identity —
 * otherwise a member silently drops out of the person it was merged into, and
 * baaki_people_i_owe shows the same human as two Friends rows again. These pin
 * the union and its idempotency at the database, where it is enforced.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';

import { connect, seedGroup } from './helpers.js';

/** The owner-scoped advisory key baaki_merge_ghosts takes, mirrored for the test. */
const LOCK_PROBE = `SELECT pg_try_advisory_xact_lock(hashtext('baaki_merge_ghosts:' || $1)::bigint) AS got`;

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

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

async function merge(profileId: string, memberIds: string[], name: string): Promise<string> {
  return asUser(profileId, async () => {
    const { rows } = await client.query(`SELECT baaki_merge_ghosts($1::uuid[], $2) AS person_id`, [
      memberIds,
      name,
    ]);
    return String(rows[0]?.person_id);
  });
}

async function personIdOf(owner: string, memberId: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT person_id FROM ghost_merges WHERE owner = $1 AND member_id = $2`,
    [owner, memberId],
  );
  return rows[0]?.person_id ? String(rows[0].person_id) : null;
}

describe('merging guests unions overlapping groups', () => {
  it('folds a transitive merge into one identity', async () => {
    // One group, one real caller, three ghosts they share it with.
    const { profileIds, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 3 });
    const caller = profileIds[0]!;
    const [, ghostA, ghostB, ghostC] = memberIds;

    await merge(caller, [ghostA!, ghostB!], 'Rahul');
    // The second merge shares ghostB with the first — all three must converge,
    // not split ghostA off onto its own person.
    await merge(caller, [ghostB!, ghostC!], 'Rahul');

    const pa = await personIdOf(caller, ghostA!);
    const pb = await personIdOf(caller, ghostB!);
    const pc = await personIdOf(caller, ghostC!);
    expect(pa).not.toBeNull();
    expect(pb).toBe(pa);
    expect(pc).toBe(pa);
  });

  it('is idempotent — merging the same pair twice keeps one stable identity', async () => {
    const { profileIds, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 2 });
    const caller = profileIds[0]!;
    const [, ghostA, ghostB] = memberIds;

    const first = await merge(caller, [ghostA!, ghostB!], 'Rahul');

    // Snapshot after the first merge, so the repeat can be proven a no-op.
    const snapshot = async (): Promise<{ created: string; seq: number }[]> => {
      const { rows } = await client.query(
        `SELECT created_at::text AS created, updated_seq FROM ghost_merges
          WHERE owner = $1 AND member_id = ANY($2::uuid[]) ORDER BY member_id`,
        [caller, [ghostA, ghostB]],
      );
      return rows.map((row) => ({ created: String(row.created), seq: Number(row.updated_seq) }));
    };
    const before = await snapshot();

    const second = await merge(caller, [ghostA!, ghostB!], 'Rahul');
    expect(second).toBe(first);

    const { rows } = await client.query(
      `SELECT count(DISTINCT person_id)::int AS people, count(*)::int AS rows
         FROM ghost_merges WHERE owner = $1 AND member_id = ANY($2::uuid[])`,
      [caller, [ghostA, ghostB]],
    );
    expect(rows[0]?.people).toBe(1);
    expect(rows[0]?.rows).toBe(2);

    // A true no-op: created_at is preserved and no new updated_seq is stamped,
    // so an identical re-merge does not re-propagate to every device.
    expect(await snapshot()).toEqual(before);
  });

  it('stamps updated_seq so the merge can be pulled into the mirror', async () => {
    // The sync trigger (20260816120000) advances a per-owner counter on every
    // merge, so an offline Friends read can fold it (A38). Both members written
    // by one merge get a positive, distinct seq, and the profile counter moves.
    const { profileIds, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 2 });
    const caller = profileIds[0]!;
    const [, ghostA, ghostB] = memberIds;

    await merge(caller, [ghostA!, ghostB!], 'Rahul');

    const { rows } = await client.query(
      `SELECT member_id, updated_seq FROM ghost_merges
        WHERE owner = $1 ORDER BY updated_seq`,
      [caller],
    );
    expect(rows).toHaveLength(2);
    const seqs = rows.map((row) => Number(row.updated_seq));
    expect(seqs.every((seq) => seq > 0)).toBe(true);
    expect(new Set(seqs).size).toBe(2); // distinct — the pull orders by it

    const counter = await client.query(`SELECT ghost_merges_seq FROM profiles WHERE id = $1`, [
      caller,
    ]);
    expect(Number(counter.rows[0]?.ghost_merges_seq)).toBeGreaterThanOrEqual(2);
  });

  it('serialises overlapping merges by the same owner, so a race cannot split them', async () => {
    // The bug this guards: {A,B} and {B,C} racing both read "no existing person"
    // and mint separate identities, splitting A from C. The fix is an
    // owner-scoped transaction advisory lock; this proves the merge holds it, so
    // a concurrent overlapping merge must wait rather than interleave.
    const { profileIds, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 3 });
    const caller = profileIds[0]!;
    const [, ghostA, ghostB, ghostC] = memberIds;

    const other = await connect();
    try {
      // Hold an open transaction across the first merge, so its advisory lock stays held.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
        JSON.stringify({ sub: caller, role: 'authenticated' }),
      ]);
      await client.query('SET ROLE authenticated');
      await client.query(`SELECT baaki_merge_ghosts($1::uuid[], $2)`, [[ghostA, ghostB], 'Rahul']);

      // A second session cannot take the same owner's merge lock while it is held.
      const held = await other.query(LOCK_PROBE, [caller]);
      expect(held.rows[0]?.got).toBe(false);

      await client.query('RESET ROLE');
      await client.query('COMMIT');

      // Once the first merge commits, the lock is free again.
      const free = await other.query(LOCK_PROBE, [caller]);
      expect(free.rows[0]?.got).toBe(true);
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      await other.end();
    }

    // And the overlapping merge the lock forces racers to run sequentially still
    // converges all three onto one identity, never a split.
    await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: caller, role: 'authenticated' }),
    ]);
    await client.query('SET ROLE authenticated');
    await client.query(`SELECT baaki_merge_ghosts($1::uuid[], $2)`, [[ghostB, ghostC], 'Rahul']);
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);

    const pa = await personIdOf(caller, ghostA!);
    expect(pa).not.toBeNull();
    expect(await personIdOf(caller, ghostB!)).toBe(pa);
    expect(await personIdOf(caller, ghostC!)).toBe(pa);
  });
});
