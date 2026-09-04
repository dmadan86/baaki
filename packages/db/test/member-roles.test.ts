/**
 * An admin can make another member an admin — and the ways that must not work.
 *
 * The self-promotion block from the security hardening stays shut; this proves
 * the one shape that is now allowed (an admin promoting somebody else) works,
 * and that the guards around it hold: a ghost cannot be an admin, a group keeps
 * its last admin, and a non-admin can promote nobody.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied, seedGroup } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function as<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query('SET ROLE authenticated');
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

const roleOf = async (memberId: string): Promise<string> => {
  const { rows } = await client.query(
    `SELECT role::text AS role FROM group_members WHERE id = $1`,
    [memberId],
  );
  return rows[0].role as string;
};

describe('an admin promotes another member', () => {
  it('makes a member an admin', async () => {
    const g = await seedGroup(client, { memberCount: 2 });
    await as(g.profileIds[0] as string, async () => {
      await client.query(`SELECT waves_set_member_role($1, 'admin')`, [g.memberIds[1]]);
    });
    expect(await roleOf(g.memberIds[1] as string)).toBe('admin');
  });

  it('refuses a non-admin', async () => {
    const g = await seedGroup(client, { memberCount: 2 });
    await as(g.profileIds[1] as string, async () => {
      const message = await expectDenied(
        client.query(`SELECT waves_set_member_role($1, 'admin')`, [g.memberIds[1]]),
      );
      expect(message).toMatch(/NOT_AN_ADMIN/);
    });
  });

  it('will not make a ghost an admin — it has no account to act with', async () => {
    const g = await seedGroup(client, { memberCount: 1, ghostCount: 1 });
    const ghostId = g.memberIds[1]; // the ghost seeded after the one real member
    await as(g.profileIds[0] as string, async () => {
      const message = await expectDenied(
        client.query(`SELECT waves_set_member_role($1, 'admin')`, [ghostId]),
      );
      expect(message).toMatch(/GHOST_CANNOT_ADMIN/);
    });
  });

  it('will not demote the last admin', async () => {
    const g = await seedGroup(client, { memberCount: 2 }); // one admin (member 0)
    await as(g.profileIds[0] as string, async () => {
      const message = await expectDenied(
        client.query(`SELECT waves_set_member_role($1, 'member')`, [g.memberIds[0]]),
      );
      expect(message).toMatch(/LAST_ADMIN/);
    });
    expect(await roleOf(g.memberIds[0] as string)).toBe('admin');
  });

  it('demotes once a second admin exists', async () => {
    const g = await seedGroup(client, { memberCount: 2 });
    await as(g.profileIds[0] as string, async () => {
      await client.query(`SELECT waves_set_member_role($1, 'admin')`, [g.memberIds[1]]);
      // Now two admins — the first may step down.
      await client.query(`SELECT waves_set_member_role($1, 'member')`, [g.memberIds[0]]);
    });
    expect(await roleOf(g.memberIds[0] as string)).toBe('member');
    expect(await roleOf(g.memberIds[1] as string)).toBe('admin');
  });

  it('still cannot be done by a direct column write', async () => {
    const g = await seedGroup(client, { memberCount: 2 });
    await as(g.profileIds[1] as string, async () => {
      const message = await expectDenied(
        client.query(`UPDATE group_members SET role = 'admin' WHERE id = $1`, [g.memberIds[1]]),
      );
      expect(message).toMatch(/FORBIDDEN_COLUMN|permission denied/i);
    });
  });
});
