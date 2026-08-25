/**
 * A wrinkle in the "asking is not taking" design (memberClaims / A6): claiming
 * a ghost is a two-step handshake — `invite-accept` files a pending
 * `member_claims` row via `baaki_request_member_claim`, and nothing about the
 * group changes until an admin decides via `baaki_decide_member_claim`.
 *
 * But the invite's `max_uses` slot is NOT part of that handshake. Per
 * `invite-accept` (see the "Reserve a use atomically before creating
 * anything" comment there), `baaki_consume_invite` is called BEFORE the claim
 * branch runs, so the slot is burned the moment someone taps "claim Ravi" —
 * whether or not an admin ever agrees they are Ravi.
 *
 * These tests lock in that current behaviour at the DB/RPC level (the edge
 * function itself is Deno and out of scope here): a one-use invite is spent by
 * a claim request alone, and staying spent even if the claim is later
 * declined or withdrawn. Nothing here is changed — see the TODO(product) on
 * each test for the actual wrinkle.
 */

import { randomUUID, createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, seedGroup } from './helpers';

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

/** A one-use invite, inserted directly the way invite-mint would leave it —
 *  not the durable join-link RPC, whose max_uses is effectively unlimited. */
async function mintSingleUseInvite(groupId: string): Promise<string> {
  const inviteId = randomUUID();
  const token = randomUUID().replace(/-/g, '');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await client.query(
    `INSERT INTO invites (id, group_id, token_hash, expires_at, max_uses, use_count)
     VALUES ($1, $2, $3, now() + interval '7 days', 1, 0)`,
    [inviteId, groupId, tokenHash],
  );
  return inviteId;
}

const consume = (inviteId: string) =>
  client
    .query(`SELECT baaki_consume_invite($1) AS ok`, [inviteId])
    .then((r) => (r.rows[0].ok as boolean | null) ?? null);

const useCountOf = (inviteId: string) =>
  client
    .query(`SELECT use_count, max_uses FROM invites WHERE id = $1`, [inviteId])
    .then((r) => r.rows[0] as { use_count: number; max_uses: number });

describe('a pending claim spends the invite slot before anyone decides', () => {
  it('TODO(product): filing the claim (not deciding it) exhausts a one-use link', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 1, ghostCount: 1 });
    const ghostId = memberIds[1] as string;
    const arrival = await newcomer();

    const inviteId = await mintSingleUseInvite(groupId);
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 0, max_uses: 1 });

    // Mirrors invite-accept's order: reserve the use, THEN ask for the claim.
    expect(await consume(inviteId)).toBe(true);
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1 });

    const { rows } = await client.query(
      `SELECT public.baaki_request_member_claim($1, $2, $3, $4) AS verdict`,
      [groupId, ghostId, arrival, 'Ravi'],
    );
    const verdict = rows[0].verdict as { ok: boolean; claim_id?: string };
    expect(verdict.ok).toBe(true);

    // The claim is only PENDING — nobody has decided anything — yet the
    // link's only slot is already spent. A second person who wanted to join
    // this same link (as themselves, or to dispute the claim) finds it dead.
    expect(await consume(inviteId)).toBeNull();

    // The ghost itself is still untouched while the claim waits, same as
    // memberClaims.test.ts's first assertion — the slot burns independently
    // of whether the claim ever succeeds.
    const ghost = await client
      .query(`SELECT profile_id, ghost_name FROM group_members WHERE id = $1`, [ghostId])
      .then((r) => r.rows[0]);
    expect(ghost.profile_id).toBeNull();
    expect(ghost.ghost_name).toBe('Ghost 1');
  });

  it('TODO(product): the slot stays spent even when the admin declines the claim', async () => {
    const { groupId, memberIds, profileIds } = await seedGroup(client, {
      memberCount: 1,
      ghostCount: 1,
    });
    const ghostId = memberIds[1] as string;
    const admin = profileIds[0] as string;
    const arrival = await newcomer();

    const inviteId = await mintSingleUseInvite(groupId);
    await consume(inviteId);

    const { rows } = await client.query(
      `SELECT public.baaki_request_member_claim($1, $2, $3, $4) AS verdict`,
      [groupId, ghostId, arrival, 'Ravi'],
    );
    const claimId = (rows[0].verdict as { claim_id: string }).claim_id;

    const decision = await asProfile(admin, () =>
      client
        .query(`SELECT public.baaki_decide_member_claim($1, $2) AS v`, [claimId, false])
        .then((r) => r.rows[0].v as { ok: boolean; status: string }),
    );
    expect(decision).toMatchObject({ ok: true, status: 'declined' });

    // Nobody ever joined this group through this link — the request was
    // refused — but the link's one use is gone all the same, and nobody who
    // holds it can try again.
    expect(await consume(inviteId)).toBeNull();
    expect(await useCountOf(inviteId)).toMatchObject({ use_count: 1, max_uses: 1 });
  });
});
