/**
 * A pending ghost-claim must not burn an invite use it can never give back.
 *
 * Claiming a ghost is a two-step handshake (memberClaims / A6): `invite-accept`
 * files a pending `member_claims` row via `baaki_request_member_claim`, and
 * nothing about the group changes until an admin decides via
 * `baaki_decide_member_claim`.
 *
 * The abuse this file guards against: the invite's `max_uses` slot used to be
 * consumed in `invite-accept` BEFORE the claim branch ran, so the slot was
 * burned the instant someone tapped "claim Ravi" — every tap, whether or not an
 * admin ever agreed. A pending claimant is not a member, so a repeat request
 * returned `already_pending` while the caller had already re-run the consume,
 * meaning one person could empty a valid link by re-POSTing the same claim.
 *
 * The fix (migration 20260825240000): consumption moved INTO
 * `baaki_request_member_claim`, which now takes the invite id and spends exactly
 * one use for a genuinely-NEW claim and nothing for a repeat or a doomed one. A
 * direct (non-claim) join is unchanged — invite-accept still calls
 * `baaki_consume_invite` once before inserting the membership.
 *
 * These tests exercise the RPC layer directly (the edge function is Deno and out
 * of scope here). They mirror invite-accept's new order: the claim RPC is given
 * the invite id and owns the reservation.
 */

import { randomUUID, createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { CONNECTION_STRING, connect, seedGroup } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/** Session-scoped (not a rolled-back tx): baaki_decide_member_claim's writes
 *  have to survive the call to be asserted on, same as memberClaims.test.ts. */
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

async function newcomer(name = 'Arrival'): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, $2, 'INR')`,
    [id, name],
  );
  return id;
}

/** An invite inserted directly the way invite-mint would leave it. `maxUses`
 *  defaults to a single use — the tightest cap, where an off-by-one matters. */
async function mintInvite(groupId: string, maxUses = 1): Promise<string> {
  const inviteId = randomUUID();
  const token = randomUUID().replace(/-/g, '');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await client.query(
    `INSERT INTO invites (id, group_id, token_hash, expires_at, max_uses, use_count)
     VALUES ($1, $2, $3, now() + interval '7 days', $4, 0)`,
    [inviteId, groupId, tokenHash, maxUses],
  );
  return inviteId;
}

interface Verdict {
  ok: boolean;
  reason?: string;
  claim_id?: string;
  already_pending?: boolean;
}

/** The claim RPC as invite-accept now calls it: the invite id is passed, so the
 *  RPC owns the (idempotent) reservation of a use. */
const claim = (
  db: Client,
  groupId: string,
  memberId: string,
  profileId: string,
  inviteId: string | null,
  name: string | null = null,
): Promise<Verdict> =>
  db
    .query(`SELECT public.baaki_request_member_claim($1, $2, $3, $4, $5) AS verdict`, [
      groupId,
      memberId,
      profileId,
      name,
      inviteId,
    ])
    .then((r) => r.rows[0].verdict as Verdict);

/** A direct (non-claim) join reserves its slot through this same primitive —
 *  the regression guard for "a normal accept still consumes exactly one use". */
const consume = (inviteId: string): Promise<boolean | null> =>
  client
    .query(`SELECT public.baaki_consume_invite($1) AS ok`, [inviteId])
    .then((r) => (r.rows[0].ok as boolean | null) ?? null);

const useCountOf = (inviteId: string): Promise<{ use_count: number; max_uses: number }> =>
  client
    .query(`SELECT use_count, max_uses FROM invites WHERE id = $1`, [inviteId])
    .then((r) => r.rows[0] as { use_count: number; max_uses: number });

const pendingClaimCount = (groupId: string): Promise<number> =>
  client
    .query(`SELECT count(*)::int AS n FROM member_claims WHERE group_id = $1`, [groupId])
    .then((r) => r.rows[0].n as number);

describe('a pending claim reserves exactly one use, idempotently', () => {
  it('spends one use for a genuinely-new claim and nothing on repeats', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 1 });
    const ghostId = memberIds[1] as string;
    const arrival = await newcomer();

    const inviteId = await mintInvite(groupId, 3);
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 0, max_uses: 3 });

    // First claim: a brand-new pending row, one use spent.
    const first = await claim(client, groupId, ghostId, arrival, inviteId, 'Ravi');
    expect(first).toMatchObject({ ok: true, already_pending: false });
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 3 });

    // The same person tapping again, four more times. Each is already_pending
    // against the same claim — and, the point of this file, spends no further
    // use. Before the fix this loop would have driven use_count to 5.
    for (let i = 0; i < 4; i += 1) {
      const again = await claim(client, groupId, ghostId, arrival, inviteId, 'Ravi');
      expect(again).toMatchObject({ ok: true, already_pending: true });
      expect(again.claim_id).toBe(first.claim_id);
    }
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 3 });

    // Only one pending claim exists, and the ghost is still untouched — the
    // reservation is independent of the claim ever being approved.
    expect(await pendingClaimCount(groupId)).toBe(1);
    const ghost = await client
      .query(`SELECT profile_id, ghost_name FROM group_members WHERE id = $1`, [ghostId])
      .then((r) => r.rows[0]);
    expect(ghost.profile_id).toBeNull();
    expect(ghost.ghost_name).toBe('Ghost 1');
  });

  it('lets a bogus claim spend nothing, so it cannot exhaust the link', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 2,
      ghostCount: 1,
    });
    const realMemberId = memberIds[1] as string; // already belongs to a person
    const ghostId = memberIds[2] as string;
    const arrival = await newcomer();

    const inviteId = await mintInvite(groupId, 1);

    // A claim on a place that already belongs to somebody: refused, no use spent.
    const taken = await claim(client, groupId, realMemberId, arrival, inviteId);
    expect(taken).toMatchObject({ ok: false, reason: 'ALREADY_CLAIMED' });

    // A claim on a member that isn't in this group at all: refused, no use spent.
    const nowhere = await claim(client, groupId, randomUUID(), arrival, inviteId);
    expect(nowhere).toMatchObject({ ok: false, reason: 'NOT_CLAIMABLE' });

    // A member of the group trying to claim a ghost of it: refused, no use spent.
    const already = await claim(client, groupId, ghostId, profileIds[1] as string, inviteId);
    expect(already).toMatchObject({ ok: false, reason: 'ALREADY_A_MEMBER' });

    // None of that touched the link. Its single slot is still free for a real
    // person to join.
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 0, max_uses: 1 });
    expect(await pendingClaimCount(groupId)).toBe(0);
    expect(await consume(inviteId)).toBe(true);
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1 });
  });

  it('refuses a claim on a link that is already spent, and writes nothing', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 1 });
    const ghostId = memberIds[1] as string;
    const arrival = await newcomer();

    const inviteId = await mintInvite(groupId, 1);
    // A direct join takes the only slot.
    expect(await consume(inviteId)).toBe(true);

    // The claim now finds the link full: refused with INVITE_INVALID, and no
    // pending row is left behind.
    const verdict = await claim(client, groupId, ghostId, arrival, inviteId, 'Ravi');
    expect(verdict).toMatchObject({ ok: false, reason: 'INVITE_INVALID' });
    expect(await pendingClaimCount(groupId)).toBe(0);
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1 });
  });

  it('the declined claim keeps its reserved use spent (no auto-refund)', async () => {
    // Documenting the chosen semantic: a genuinely-new claim reserves one use,
    // and declining it does not hand the use back. The abuse that was fixed is
    // *repeat* / bogus exhaustion (above), not the single legitimate reservation.
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 1,
      ghostCount: 1,
    });
    const ghostId = memberIds[1] as string;
    const admin = profileIds[0] as string;
    const arrival = await newcomer();

    const inviteId = await mintInvite(groupId, 1);
    const { claim_id } = await claim(client, groupId, ghostId, arrival, inviteId, 'Ravi');
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1 });

    const decision = await asProfile(admin, () =>
      client
        .query(`SELECT public.baaki_decide_member_claim($1, $2) AS v`, [claim_id, false])
        .then((r) => r.rows[0].v as { ok: boolean; status: string }),
    );
    expect(decision).toMatchObject({ ok: true, status: 'declined' });
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1 });
  });
});

describe('the durable join link is unaffected', () => {
  it('lets a claim through and stays effectively unlimited', async () => {
    // The durable (WhatsApp-style) link carries an effectively unlimited
    // max_uses, so a claim consuming one leaves it live for everyone else.
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 1 });
    const ghostId = memberIds[1] as string;
    const arrival = await newcomer();

    const inviteId = await mintInvite(groupId, 1_000_000);
    const verdict = await claim(client, groupId, ghostId, arrival, inviteId, 'Ravi');
    expect(verdict).toMatchObject({ ok: true, already_pending: false });
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1_000_000 });
  });
});

describe('concurrent redemption of the last slot', () => {
  it('admits only one real join when two new claims race for it', async () => {
    // Two different arrivals, each claiming a different ghost through the SAME
    // one-use link at the same moment. The atomic consume inside the RPC lets
    // exactly one win the last slot; the other is turned away INVITE_INVALID and
    // leaves no pending row.
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 2 });
    const ghostA = memberIds[1] as string;
    const ghostB = memberIds[2] as string;
    const arrivalA = await newcomer('A');
    const arrivalB = await newcomer('B');

    const inviteId = await mintInvite(groupId, 1);

    // Two independent connections so the two RPC calls really are concurrent
    // transactions racing on the invite row.
    const a = new Client({ connectionString: CONNECTION_STRING });
    const b = new Client({ connectionString: CONNECTION_STRING });
    await Promise.all([a.connect(), b.connect()]);
    let results: Verdict[];
    try {
      results = await Promise.all([
        claim(a, groupId, ghostA, arrivalA, inviteId, 'Ravi'),
        claim(b, groupId, ghostB, arrivalB, inviteId, 'Meera'),
      ]);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toBe('INVITE_INVALID');

    // Exactly one slot spent, exactly one pending claim filed.
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1 });
    expect(await pendingClaimCount(groupId)).toBe(1);
  });
});

describe('a normal (non-claim) accept', () => {
  it('still consumes exactly one use', async () => {
    // The direct-join path in invite-accept reserves its slot through
    // baaki_consume_invite, unchanged by this migration. Guard it: one success,
    // then the link is spent.
    const { groupId } = await seedGroup(client, { memberCount: 1 });
    const inviteId = await mintInvite(groupId, 1);

    expect(await consume(inviteId)).toBe(true);
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1 });
    expect(await consume(inviteId)).toBeNull();
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1 });
  });
});
