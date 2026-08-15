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
    const second = await merge(caller, [ghostA!, ghostB!], 'Rahul');
    expect(second).toBe(first);

    const { rows } = await client.query(
      `SELECT count(DISTINCT person_id)::int AS people, count(*)::int AS rows
         FROM ghost_merges WHERE owner = $1 AND member_id = ANY($2::uuid[])`,
      [caller, [ghostA, ghostB]],
    );
    expect(rows[0]?.people).toBe(1);
    expect(rows[0]?.rows).toBe(2);
  });
});
