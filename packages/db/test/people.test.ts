/**
 * "Who do I owe, and who owes me" across every group.
 *
 * The three things worth pinning are all cases where a plausible wrong number
 * would otherwise reach somebody:
 *
 *   - the same person across two groups must add up to one figure;
 *   - two ghosts with the same name must NOT, because nothing proves they are
 *     one human and merging debts is not reversible;
 *   - currencies must never be summed together.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

async function profile(name: string): Promise<string> {
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

async function makeGroup(owner: string, currency = 'INR'): Promise<string> {
  return asUser(owner, async () => {
    const { rows } = await client.query(
      `SELECT baaki_create_group('Trip', 'trip', $1, NULL, false, NULL, NULL) AS id`,
      [currency],
    );
    return String(rows[0].id);
  });
}

async function addGhost(owner: string, groupId: string, name: string): Promise<string> {
  return asUser(owner, async () => {
    const { rows } = await client.query(`SELECT baaki_add_ghost_member($1::uuid, $2::text) AS id`, [
      groupId,
      name,
    ]);
    return String(rows[0].id);
  });
}

async function myMember(groupId: string, profileId: string): Promise<string> {
  const { rows } = await client.query(
    `SELECT id FROM group_members WHERE group_id = $1 AND profile_id = $2`,
    [groupId, profileId],
  );
  return String(rows[0].id);
}

/**
 * An expense somebody paid, split equally with one other member, recorded by
 * `owner`.
 *
 * The payer and the person typing it in are two different people whenever
 * anybody records "Ravi got this one" — so the author is the caller, never the
 * payer. Conflating them used to pass; since
 * 20260807090000_security_hardening an expense may only be recorded as written
 * by whoever wrote it, and the two must be told apart here too.
 */
async function expense(
  owner: string,
  groupId: string,
  payer: string,
  other: string,
  amount: bigint,
  currency = 'INR',
): Promise<void> {
  const half = amount / 2n;
  const author = await myMember(groupId, owner);
  await asUser(owner, () =>
    client.query(
      `SELECT baaki_apply_expense($1::uuid, $2::uuid, $3::uuid, 'Dinner', NULL::text,
                                  '2026-08-06'::date, $4::char(3), $5::bigint,
                                  'equal'::text, '{"kind":"equal"}'::jsonb,
                                  $6::jsonb, $7::jsonb, $8::uuid)`,
      [
        groupId,
        randomUUID(),
        author,
        currency,
        amount.toString(),
        JSON.stringify([{ memberId: payer, amount: amount.toString() }]),
        JSON.stringify([
          { memberId: payer, amount: half.toString() },
          { memberId: other, amount: (amount - half).toString() },
        ]),
        randomUUID(),
      ],
    ),
  );
}

async function people(profileId: string) {
  return asUser(profileId, async () => {
    const { rows } = await client.query(`SELECT * FROM baaki_people_i_owe()`);
    return rows;
  });
}

describe('one person, several groups', () => {
  it('adds the same person up across groups', async () => {
    const asha = await profile('Asha');
    const ravi = await profile('Ravi');

    // Ravi is a real member of both groups, so his profile identifies him.
    for (const _ of [1, 2]) {
      void _;
    }
    const groupA = await makeGroup(asha);
    const groupB = await makeGroup(asha);
    for (const groupId of [groupA, groupB]) {
      await client.query(
        `INSERT INTO group_members (group_id, profile_id, joined_via) VALUES ($1, $2, 'invite_link')`,
        [groupId, ravi],
      );
    }

    const ashaA = await myMember(groupA, asha);
    const raviA = await myMember(groupA, ravi);
    const ashaB = await myMember(groupB, asha);
    const raviB = await myMember(groupB, ravi);

    await expense(asha, groupA, ashaA, raviA, 100000n); // Ravi owes 500
    await expense(asha, groupB, ashaB, raviB, 40000n); //  Ravi owes 200

    const rows = await people(asha);
    expect(rows).toHaveLength(1);
    expect(rows[0].display_name).toBe('Ravi');
    expect(BigInt(rows[0].net)).toBe(70000n);
    expect(rows[0].group_count).toBe(2);
    // Two groups, so there is no single group to link to.
    expect(rows[0].only_group_id).toBeNull();
  });

  it('says which group when there is only one', async () => {
    const asha = await profile('Asha');
    const groupId = await makeGroup(asha);
    const ghost = await addGhost(asha, groupId, 'Ravi');
    await expense(asha, groupId, await myMember(groupId, asha), ghost, 100000n);

    const rows = await people(asha);
    expect(rows[0].group_count).toBe(1);
    expect(rows[0].only_group_id).toBe(groupId);
  });
});

describe('ghosts are not merged across groups', () => {
  it('keeps two same-named ghosts apart', async () => {
    // Nothing proves the Ravi in one group is the Ravi in another, and merging
    // two people's debts cannot be undone afterwards.
    const asha = await profile('Asha');
    const groupA = await makeGroup(asha);
    const groupB = await makeGroup(asha);

    const raviA = await addGhost(asha, groupA, 'Ravi');
    const raviB = await addGhost(asha, groupB, 'Ravi');

    await expense(asha, groupA, await myMember(groupA, asha), raviA, 100000n);
    await expense(asha, groupB, await myMember(groupB, asha), raviB, 40000n);

    const rows = await people(asha);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.is_ghost)).toBe(true);
    expect(rows.map((row) => BigInt(row.net)).sort()).toEqual([20000n, 50000n]);
  });
});

describe('currencies stay apart', () => {
  it('never sums two currencies into one number', async () => {
    const asha = await profile('Asha');
    const ravi = await profile('Ravi');
    const groupA = await makeGroup(asha, 'INR');
    const groupB = await makeGroup(asha, 'EUR');
    for (const groupId of [groupA, groupB]) {
      await client.query(
        `INSERT INTO group_members (group_id, profile_id, joined_via) VALUES ($1, $2, 'invite_link')`,
        [groupId, ravi],
      );
    }

    await expense(
      asha,
      groupA,
      await myMember(groupA, asha),
      await myMember(groupA, ravi),
      100000n,
    );
    await expense(
      asha,
      groupB,
      await myMember(groupB, asha),
      await myMember(groupB, ravi),
      4000n,
      'EUR',
    );

    const rows = await people(asha);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.currency).sort()).toEqual(['EUR', 'INR']);
    // One person, two rows — a single total would need a rate that nobody chose.
    expect(new Set(rows.map((row) => row.person_key)).size).toBe(1);
  });
});

describe('what is left out', () => {
  it('omits anybody who is settled up', async () => {
    // A row of zero would turn this into a list of everybody you have ever
    // split with, which is not the question being asked.
    const asha = await profile('Asha');
    const groupId = await makeGroup(asha);
    const ghost = await addGhost(asha, groupId, 'Ravi');
    const ashaMember = await myMember(groupId, asha);

    await expense(asha, groupId, ashaMember, ghost, 100000n);
    await expense(asha, groupId, ghost, ashaMember, 100000n);

    expect(await people(asha)).toHaveLength(0);
  });

  it('shows nothing to somebody in no groups', async () => {
    const stranger = await profile('Nobody');
    expect(await people(stranger)).toHaveLength(0);
  });

  it('never leaks a group the caller is not in', async () => {
    const asha = await profile('Asha');
    const stranger = await profile('Nobody');
    const groupId = await makeGroup(asha);
    const ghost = await addGhost(asha, groupId, 'Ravi');
    await expense(asha, groupId, await myMember(groupId, asha), ghost, 100000n);

    expect(await people(stranger)).toHaveLength(0);
  });
});

describe('direction', () => {
  it('reports a debt you owe as negative', async () => {
    const asha = await profile('Asha');
    const groupId = await makeGroup(asha);
    const ghost = await addGhost(asha, groupId, 'Ravi');
    const ashaMember = await myMember(groupId, asha);

    // Ravi paid; Asha owes half.
    await expense(asha, groupId, ghost, ashaMember, 100000n);

    const rows = await people(asha);
    expect(BigInt(rows[0].net)).toBe(-50000n);
  });
});
