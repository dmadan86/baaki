/**
 * Nudging somebody who owes you to settle (ADR-010).
 *
 * The tone is the feature, and the tone lives in the refusals — so those are
 * what is pinned here:
 *
 *   - a nudge only goes when the debt is real, in the currency named;
 *   - a second nudge the same day is refused, so Baaki cannot be turned into a
 *     machine that pesters;
 *   - a ghost, who has no inbox, is never nudged;
 *   - and only a member of the group can nudge inside it.
 *
 * The happy path is here too, but it is the least interesting line: what makes
 * this a reminder and not a collections agency is everything it declines to do.
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

async function makeGroup(owner: string): Promise<string> {
  return asUser(owner, async () => {
    const { rows } = await client.query(
      `SELECT baaki_create_group('Goa', 'trip', 'INR', NULL, false, NULL, NULL) AS id`,
    );
    return String(rows[0].id);
  });
}

async function join(groupId: string, profileId: string): Promise<void> {
  await client.query(
    `INSERT INTO group_members (group_id, profile_id, joined_via) VALUES ($1, $2, 'invite_link')`,
    [groupId, profileId],
  );
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

/** `payer` pays `amount`, split equally between payer and `other`; recorded by `owner`. */
async function expense(
  owner: string,
  groupId: string,
  payer: string,
  other: string,
  amount: bigint,
): Promise<void> {
  const half = amount / 2n;
  const author = await myMember(groupId, owner);
  await asUser(owner, () =>
    client.query(
      `SELECT baaki_apply_expense($1::uuid, $2::uuid, $3::uuid, 'Dinner', NULL::text,
                                  '2026-08-06'::date, 'INR'::char(3), $4::bigint,
                                  'equal'::text, '{"kind":"equal"}'::jsonb,
                                  $5::jsonb, $6::jsonb, $7::uuid)`,
      [
        groupId,
        randomUUID(),
        author,
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

function nudge(caller: string, groupId: string, toMemberId: string, currency = 'INR') {
  return asUser(caller, () =>
    client.query(`SELECT baaki_nudge_to_settle($1::uuid, $2::uuid, $3::char(3)) AS id`, [
      groupId,
      toMemberId,
      currency,
    ]),
  );
}

/**
 * A group where Ravi owes Asha ₹500 in one shared dinner. Returned ids are the
 * two profiles and their members, so a test can nudge in either direction.
 */
async function owingPair(): Promise<{
  asha: string;
  ravi: string;
  groupId: string;
  ashaMember: string;
  raviMember: string;
}> {
  const asha = await profile('Asha');
  const ravi = await profile('Ravi');
  const groupId = await makeGroup(asha);
  await join(groupId, ravi);
  const ashaMember = await myMember(groupId, asha);
  const raviMember = await myMember(groupId, ravi);
  await expense(asha, groupId, ashaMember, raviMember, 1000n);
  return { asha, ravi, groupId, ashaMember, raviMember };
}

describe('a nudge that is real', () => {
  it('writes the debtor an inbox row with the amount they owe', async () => {
    const { asha, ravi, groupId, ashaMember, raviMember } = await owingPair();

    const result = await nudge(asha, groupId, raviMember);
    expect(result.rows[0].id).not.toBeNull();

    const { rows } = await client.query(
      `SELECT kind, group_id, payload FROM notifications WHERE profile_id = $1`,
      [ravi],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('nudge');
    expect(String(rows[0].group_id)).toBe(groupId);
    expect(rows[0].payload.amount).toBe('500');
    expect(rows[0].payload.currency).toBe('INR');
    expect(rows[0].payload.counterparty).toBe('Asha');
    expect(rows[0].payload.group).toBe('Goa');

    const reminder = await client.query(
      `SELECT last_nudged_at FROM reminders
        WHERE group_id = $1 AND from_member_id = $2 AND to_member_id = $3`,
      [groupId, ashaMember, raviMember],
    );
    expect(reminder.rows).toHaveLength(1);
    expect(reminder.rows[0].last_nudged_at).not.toBeNull();
  });
});

describe('the refusals that keep it kind', () => {
  it('refuses a second nudge the same day', async () => {
    const { asha, groupId, raviMember } = await owingPair();
    await nudge(asha, groupId, raviMember);
    await expect(nudge(asha, groupId, raviMember)).rejects.toThrow(/NUDGE_RATE_LIMIT/);
  });

  it('refuses to nudge over a debt that runs the other way', async () => {
    // Ravi owes Asha, so Ravi has nothing to reproach Asha with.
    const { ravi, groupId, ashaMember } = await owingPair();
    await expect(nudge(ravi, groupId, ashaMember)).rejects.toThrow(/NOTHING_OWED/);
  });

  it('refuses to nudge in a currency that is square even when another is not', async () => {
    const { asha, groupId, raviMember } = await owingPair();
    await expect(nudge(asha, groupId, raviMember, 'EUR')).rejects.toThrow(/NOTHING_OWED/);
  });

  it('refuses to nudge a ghost, who has no inbox', async () => {
    const asha = await profile('Asha');
    const groupId = await makeGroup(asha);
    const ghost = await addGhost(asha, groupId, 'Unclaimed Ravi');
    await expect(nudge(asha, groupId, ghost)).rejects.toThrow(/GHOST_NO_INBOX/);
  });

  it('refuses a caller who is not in the group', async () => {
    const { groupId, raviMember } = await owingPair();
    const stranger = await profile('Stranger');
    await expect(nudge(stranger, groupId, raviMember)).rejects.toThrow(/NOT_A_MEMBER/);
  });
});
