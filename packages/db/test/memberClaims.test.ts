/**
 * Taking somebody's place needs somebody to say yes.
 *
 * The test this file exists for is the first one: before this migration,
 * anybody holding an invite link could become the ghost "Ravi" and inherit
 * every share and settlement filed against that name, with nobody asked. The
 * rest of the file is about the ways that answer can go wrong — two admins
 * deciding at once, two people wanting the same place, an admin who never
 * answers — because a confirmation step that deadlocks is its own outage.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { asRole, connect, expectDenied, seedGroup } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/**
 * Session-scoped claims rather than a transaction that rolls back: deciding a
 * claim is a write, and the rows it makes have to survive the call to be
 * asserted on.
 */
async function asProfile<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  try {
    return await run();
  } finally {
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

/** An outsider with a profile but no membership — whoever opened the link. */
async function newcomer(name = 'Arrival'): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, $2, 'INR')`,
    [id, name],
  );
  return id;
}

/**
 * `seedGroup` hands back plain arrays, and indexing one is `string | undefined`
 * under this repo's TypeScript settings. Asserting here rather than at twenty
 * call sites — and loudly, because a seed that quietly produced fewer members
 * than the test asked for would otherwise pass `null` to Postgres and fail
 * somewhere unrelated.
 */
function id(value: string | undefined, what: string): string {
  if (!value) throw new Error(`the seed produced no ${what}`);
  return value;
}

async function request(
  groupId: string,
  memberId: string | undefined,
  profileId: string,
  name: string | null = null,
): Promise<{ ok: boolean; reason?: string; claim_id?: string; already_pending?: boolean }> {
  const { rows } = await client.query(
    'SELECT public.baaki_request_member_claim($1, $2, $3, $4) AS verdict',
    [groupId, id(memberId, 'member'), profileId, name],
  );
  return rows[0].verdict;
}

async function decide(
  claimId: string,
  approve: boolean,
  as: string | undefined,
): Promise<{ ok: boolean; reason?: string; status?: string }> {
  return asProfile(id(as, 'admin profile'), async () => {
    const { rows } = await client.query('SELECT public.baaki_decide_member_claim($1, $2) AS v', [
      claimId,
      approve,
    ]);
    return rows[0].v;
  });
}

async function memberRow(
  memberId: string | undefined,
): Promise<{ profile_id: string | null; ghost_name: string | null; joined_via: string | null }> {
  const { rows } = await client.query(
    'SELECT profile_id, ghost_name, joined_via FROM public.group_members WHERE id = $1',
    [id(memberId, 'member')],
  );
  return rows[0];
}

describe('asking is not taking', () => {
  it('changes nothing about the ghost until somebody decides', async () => {
    // The whole point. Before this migration the ghost was handed over inside
    // `invite-accept` the moment it was asked for.
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2, ghostCount: 1 });
    const ghostId = memberIds[2];
    const arrival = await newcomer();

    const verdict = await request(groupId, ghostId, arrival, 'Ravi');
    expect(verdict.ok).toBe(true);

    const ghost = await memberRow(ghostId);
    expect(ghost.profile_id).toBeNull();
    expect(ghost.ghost_name).toBe('Ghost 1');
  });

  it('tells every admin, once each', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 3,
      ghostCount: 1,
    });
    // A second admin, so "the organizer" is not read as "the creator".
    await client.query(`UPDATE group_members SET role = 'admin' WHERE id = $1`, [memberIds[1]]);

    const arrival = await newcomer();
    await request(groupId, memberIds[3], arrival, 'Ravi');

    const { rows } = await client.query(
      `SELECT profile_id FROM public.notifications
        WHERE group_id = $1 AND kind = 'ghost_claim_requested'`,
      [groupId],
    );
    expect(new Set(rows.map((r) => r.profile_id as string))).toEqual(
      new Set([profileIds[0], profileIds[1]]),
    );
  });

  it('does not notify twice when the same person asks twice', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2, ghostCount: 1 });
    const arrival = await newcomer();

    const first = await request(groupId, memberIds[2], arrival);
    const second = await request(groupId, memberIds[2], arrival);

    expect(second.already_pending).toBe(true);
    expect(second.claim_id).toBe(first.claim_id);

    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM public.notifications
        WHERE group_id = $1 AND kind = 'ghost_claim_requested'`,
      [groupId],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('deciding', () => {
  it('hands the whole history over on approval', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const ghostId = memberIds[2];
    const arrival = await newcomer();

    const { claim_id } = await request(groupId, ghostId, arrival, 'Ravi');
    const verdict = await decide(claim_id!, true, profileIds[0]);
    expect(verdict.ok).toBe(true);
    expect(verdict.status).toBe('approved');

    // The same row, now theirs: nothing was copied, so every share and
    // settlement already pointing at this member id still points at it.
    const ghost = await memberRow(ghostId);
    expect(ghost.profile_id).toBe(arrival);
    expect(ghost.ghost_name).toBeNull();
    expect(ghost.joined_via).toBe('invite_link_claim');
  });

  it('writes the name they gave only once somebody agreed', async () => {
    // The old path set `display_name` while claiming, so an unconfirmed
    // stranger could rename their own profile through a join request.
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const arrival = await newcomer('Guest');
    const { claim_id } = await request(groupId, memberIds[2], arrival, 'Ravi');

    const nameNow = async (): Promise<string> =>
      (await client.query('SELECT display_name FROM public.profiles WHERE id = $1', [arrival]))
        .rows[0].display_name;

    expect(await nameNow()).toBe('Guest');
    await decide(claim_id!, true, profileIds[0]);
    expect(await nameNow()).toBe('Ravi');
  });

  it('does not rename somebody who already named themselves', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const arrival = await newcomer('Asha Menon');
    const { claim_id } = await request(groupId, memberIds[2], arrival, 'Ravi');
    await decide(claim_id!, true, profileIds[0]);

    const { rows } = await client.query('SELECT display_name FROM public.profiles WHERE id = $1', [
      arrival,
    ]);
    expect(rows[0].display_name).toBe('Asha Menon');
  });

  it('refuses anybody who is not an admin of that group', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const arrival = await newcomer();
    const { claim_id } = await request(groupId, memberIds[2], arrival);

    // An ordinary member of the same group.
    const byMember = await decide(claim_id!, true, profileIds[1]);
    expect(byMember.ok).toBe(false);

    // A stranger, and the person who asked — who would otherwise approve
    // themselves, which is the whole hole this closes.
    const outsider = await newcomer('Nobody');
    expect((await decide(claim_id!, true, outsider)).ok).toBe(false);
    expect((await decide(claim_id!, true, arrival)).ok).toBe(false);

    expect((await memberRow(memberIds[2])).profile_id).toBeNull();
  });

  it('says the same thing to a stranger as to a claim that does not exist', async () => {
    // Otherwise the difference between the two answers is a way to enumerate
    // which claim ids are real.
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2, ghostCount: 1 });
    const arrival = await newcomer();
    const { claim_id } = await request(groupId, memberIds[2], arrival);
    const outsider = await newcomer('Nobody');

    const real = await decide(claim_id!, true, outsider);
    const imaginary = await decide(randomUUID(), true, outsider);
    expect(real.reason).toBe(imaginary.reason);
    expect(real.reason).toBe('NO_SUCH_CLAIM');
  });

  it('lets a second admin decide when the first never opens the app', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 3,
      ghostCount: 1,
    });
    await client.query(`UPDATE group_members SET role = 'admin' WHERE id = $1`, [memberIds[1]]);
    const arrival = await newcomer();
    const { claim_id } = await request(groupId, memberIds[3], arrival);

    expect((await decide(claim_id!, true, profileIds[1])).ok).toBe(true);
  });

  it('cannot be decided twice', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const arrival = await newcomer();
    const { claim_id } = await request(groupId, memberIds[2], arrival);

    expect((await decide(claim_id!, false, profileIds[0])).ok).toBe(true);
    const again = await decide(claim_id!, true, profileIds[0]);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('ALREADY_DECIDED');
  });

  it('declines everybody else waiting on the same place', async () => {
    // Two people both say they are Ravi. Approving one has to answer the
    // other, or an admin is later told NOT_CLAIMABLE with no idea why.
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const ghostId = memberIds[2];
    const first = await newcomer('First');
    const second = await newcomer('Second');

    const a = await request(groupId, ghostId, first);
    const b = await request(groupId, ghostId, second);
    await decide(a.claim_id!, true, profileIds[0]);

    const { rows } = await client.query('SELECT status FROM public.member_claims WHERE id = $1', [
      b.claim_id,
    ]);
    expect(rows[0].status).toBe('declined');
  });

  it('tells the person waiting, either way', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 2,
    });
    const yes = await newcomer('Yes');
    const no = await newcomer('No');

    const approved = await request(groupId, memberIds[2], yes);
    const refused = await request(groupId, memberIds[3], no);
    await decide(approved.claim_id!, true, profileIds[0]);
    await decide(refused.claim_id!, false, profileIds[0]);

    const { rows } = await client.query(
      `SELECT profile_id, kind FROM public.notifications
        WHERE kind IN ('ghost_claim_approved', 'ghost_claim_declined') AND group_id = $1`,
      [groupId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.profile_id === yes)?.kind).toBe('ghost_claim_approved');
    expect(rows.find((r) => r.profile_id === no)?.kind).toBe('ghost_claim_declined');
  });
});

describe('the ways a claim stops making sense', () => {
  it('will not take a place that already belongs to somebody', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const arrival = await newcomer();
    const verdict = await request(groupId, memberIds[0], arrival);
    expect(verdict).toMatchObject({ ok: false, reason: 'ALREADY_CLAIMED' });
  });

  it('will not give somebody a second membership of one group', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const verdict = await request(groupId, memberIds[2], id(profileIds[1], 'member profile'));
    expect(verdict).toMatchObject({ ok: false, reason: 'ALREADY_A_MEMBER' });
  });

  it('refuses approval if they joined by another route while waiting', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const arrival = await newcomer();
    const { claim_id } = await request(groupId, memberIds[2], arrival);

    await client.query(
      `INSERT INTO group_members (group_id, profile_id, joined_via) VALUES ($1, $2, 'invite_link')`,
      [groupId, arrival],
    );

    const verdict = await decide(claim_id!, true, profileIds[0]);
    expect(verdict).toMatchObject({ ok: false, reason: 'ALREADY_A_MEMBER' });
  });

  it('lets the person waiting give up, and nobody else give up for them', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const arrival = await newcomer();
    const { claim_id } = await request(groupId, memberIds[2], arrival);

    const byAdmin = await asProfile(id(profileIds[0], 'admin profile'), async () => {
      const { rows } = await client.query('SELECT public.baaki_withdraw_member_claim($1) AS v', [
        claim_id,
      ]);
      return rows[0].v;
    });
    expect(byAdmin.ok).toBe(false);

    const byThem = await asProfile(arrival, async () => {
      const { rows } = await client.query('SELECT public.baaki_withdraw_member_claim($1) AS v', [
        claim_id,
      ]);
      return rows[0].v;
    });
    expect(byThem.ok).toBe(true);

    // Withdrawn is not pending, so it can no longer be approved behind them.
    expect((await decide(claim_id!, true, profileIds[0])).reason).toBe('ALREADY_DECIDED');
  });
});

describe('who can see a claim', () => {
  it('is the person who asked and the admins, and nobody else', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 3,
      ghostCount: 1,
    });
    const arrival = await newcomer();
    await request(groupId, memberIds[3], arrival);

    // `asRole` and not a bare `SET LOCAL ROLE`: outside a transaction that is
    // a no-op, and the query then runs as the table's owner with RLS bypassed
    // — which is a test that passes no matter what the policy says. It did.
    const visibleTo = async (profileId: string): Promise<number> =>
      asRole(client, 'authenticated', { sub: profileId, role: 'authenticated' }, async () => {
        const { rows } = await client.query(
          'SELECT count(*)::int AS n FROM public.member_claims WHERE group_id = $1',
          [groupId],
        );
        return rows[0].n as number;
      });

    expect(await visibleTo(id(profileIds[0], 'admin profile'))).toBe(1); // admin
    expect(await visibleTo(arrival)).toBe(1); // the one who asked
    // An ordinary member: a declined claim is somebody being told they are not
    // who they said, and that is not the group's business.
    expect(await visibleTo(id(profileIds[1], 'member profile'))).toBe(0);
    expect(await visibleTo(await newcomer('Nobody'))).toBe(0);
  });

  it('will not let a client write the table directly', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2, ghostCount: 1 });
    const arrival = await newcomer();
    const { claim_id } = await request(groupId, memberIds[2], arrival);

    // Approving your own claim by UPDATE is the shortest way around all of it.
    const denied = await asRole(
      client,
      'authenticated',
      { sub: arrival, role: 'authenticated' },
      async () =>
        expectDenied(
          client.query(
            `UPDATE public.member_claims
                SET status = 'approved', decided_at = now()
              WHERE id = $1`,
            [claim_id],
          ),
        ),
    );
    expect(denied).toMatch(/permission denied/i);
  });
});
