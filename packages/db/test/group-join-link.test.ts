/**
 * The durable group join link — a stable, re-showable invite (the WhatsApp
 * model). These guard its lifecycle: any member can fetch it, only an admin can
 * rotate it, nobody can write the token directly, and the token it hands out
 * really resolves to a live invite the accept path will honour.
 */

import { randomUUID, createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied, seedGroup } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function as<T>(profileId: string | null, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    profileId
      ? JSON.stringify({ sub: profileId, role: 'authenticated' })
      : JSON.stringify({ role: 'anon' }),
  ]);
  await client.query(`SET ROLE ${profileId ? 'authenticated' : 'anon'}`);
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
  }
}

let g: { groupId: string; profileIds: string[]; memberIds: string[] };

beforeAll(async () => {
  g = await seedGroup(client, { memberCount: 3, name: 'JoinLink' });
});

beforeEach(async () => {
  await client.query(`UPDATE groups SET join_token = NULL WHERE id = $1`, [g.groupId]);
  await client.query(`DELETE FROM invites WHERE group_id = $1`, [g.groupId]);
});

const P = (i: number) => g.profileIds[i] as string;

const ensure = (profileId: string) =>
  as(profileId, () =>
    client
      .query(`SELECT baaki_ensure_group_join_token($1) AS token`, [g.groupId])
      .then((r) => r.rows[0].token as string),
  );

const reset = (profileId: string) =>
  as(profileId, () =>
    client
      .query(`SELECT baaki_reset_group_join_token($1) AS token`, [g.groupId])
      .then((r) => r.rows[0].token as string),
  );

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

const inviteFor = (token: string) =>
  client
    .query(
      `SELECT revoked_at, expires_at, max_uses, use_count FROM invites
        WHERE group_id = $1 AND token_hash = $2`,
      [g.groupId, sha256Hex(token)],
    )
    .then((r) => r.rows[0]);

describe('durable group join link', () => {
  it('T1 a member gets a token backed by a live invite, stored on the group', async () => {
    const token = await ensure(P(1));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stored = await client
      .query(`SELECT join_token FROM groups WHERE id = $1`, [g.groupId])
      .then((r) => r.rows[0].join_token);
    expect(stored).toBe(token);
    const invite = await inviteFor(token);
    expect(invite).toBeTruthy();
    expect(invite.revoked_at).toBeNull();
    expect(Number(invite.max_uses)).toBeGreaterThan(1000);
    expect(new Date(invite.expires_at).getFullYear()).toBeGreaterThan(2100);
  });

  it('T2 ensure is idempotent while the link is live (stable QR)', async () => {
    const a = await ensure(P(1));
    const b = await ensure(P(2));
    expect(b).toBe(a);
    const n = await client
      .query(`SELECT count(*)::int AS n FROM invites WHERE group_id = $1`, [g.groupId])
      .then((r) => r.rows[0].n as number);
    expect(n).toBe(1);
  });

  it('T3 a non-member cannot fetch the link', async () => {
    const outsider = randomUUID();
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Out', 'INR')`,
      [outsider],
    );
    const msg = await expectDenied(
      as(outsider, () => client.query(`SELECT baaki_ensure_group_join_token($1)`, [g.groupId])),
    );
    expect(msg).toMatch(/NOT_A_MEMBER/);
  });

  it('T4 an admin resets: new token, old invite revoked, new one live', async () => {
    const first = await ensure(P(1));
    const second = await reset(P(0));
    expect(second).not.toBe(first);
    expect(await inviteFor(first).then((r) => r.revoked_at)).not.toBeNull();
    expect(await inviteFor(second).then((r) => r.revoked_at)).toBeNull();
    const stored = await client
      .query(`SELECT join_token FROM groups WHERE id = $1`, [g.groupId])
      .then((r) => r.rows[0].join_token);
    expect(stored).toBe(second);
  });

  it('T5 a non-admin member cannot reset', async () => {
    await ensure(P(1));
    const msg = await expectDenied(
      as(P(1), () => client.query(`SELECT baaki_reset_group_join_token($1)`, [g.groupId])),
    );
    expect(msg).toMatch(/ADMIN_ONLY/);
  });

  it('T6 a client cannot write join_token directly (guarded column)', async () => {
    const msg = await expectDenied(
      as(P(1), () =>
        client.query(`UPDATE groups SET join_token = 'forged' WHERE id = $1`, [g.groupId]),
      ),
    );
    expect(msg).toMatch(/FORBIDDEN_COLUMN/);
  });

  it('T7 a stale/dead stored token is replaced on the next ensure', async () => {
    const token = await ensure(P(1));
    // Kill the invite behind it (as if it were revoked out of band).
    await client.query(`UPDATE invites SET revoked_at = now() WHERE group_id = $1`, [g.groupId]);
    const fresh = await ensure(P(1));
    expect(fresh).not.toBe(token);
    expect(await inviteFor(fresh).then((r) => r.revoked_at)).toBeNull();
  });
});
