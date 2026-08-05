/**
 * Groups you can start without answering any questions (ADR-006).
 *
 * A name is the least important thing about "me, Priya and Ravi in Goa", so it
 * is optional. These tests pin the two halves of that: the database accepts a
 * group with no name, and it refuses the thing that would quietly undo the
 * decision — an empty string, which sorts and exports like a name while
 * meaning the opposite.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied } from './helpers.js';

let client: Client;

async function createProfile(name: string): Promise<string> {
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

async function createGroup(
  profileId: string,
  args: { name?: string | null; groupId?: string; photoPath?: string | null } = {},
): Promise<string> {
  return asUser(profileId, async () => {
    const result = await client.query(
      `SELECT baaki_create_group($1, 'trip', 'INR', NULL, true, $2, $3) AS id`,
      [args.name ?? null, args.groupId ?? null, args.photoPath ?? null],
    );
    return String(result.rows[0]?.id);
  });
}

async function readGroup(
  groupId: string,
): Promise<{ name: string | null; photo_path: string | null }> {
  const { rows } = await client.query(`SELECT name, photo_path FROM groups WHERE id = $1`, [
    groupId,
  ]);
  return rows[0] as { name: string | null; photo_path: string | null };
}

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

describe('a group does not need a name', () => {
  it('creates one with no name at all', async () => {
    const profileId = await createProfile('Asha');
    const groupId = await createGroup(profileId);

    const group = await readGroup(groupId);
    expect(group.name).toBeNull();

    // And the creator is still its admin — nothing else about the group changed.
    const { rows } = await client.query(
      `SELECT role FROM group_members WHERE group_id = $1 AND profile_id = $2`,
      [groupId, profileId],
    );
    expect(rows[0]?.role).toBe('admin');
  });

  it('treats a name of only spaces as no name', async () => {
    const profileId = await createProfile('Asha');
    const groupId = await createGroup(profileId, { name: '   ' });
    expect((await readGroup(groupId)).name).toBeNull();
  });

  it('still trims and keeps a real name', async () => {
    const profileId = await createProfile('Asha');
    const groupId = await createGroup(profileId, { name: '  Goa trip  ' });
    expect((await readGroup(groupId)).name).toBe('Goa trip');
  });

  it('refuses an empty string, which is not the same thing as no name', async () => {
    const profileId = await createProfile('Asha');
    const groupId = await createGroup(profileId, { name: 'Goa trip' });

    // NULL means "unnamed" and every reader handles it. '' means "unnamed" to a
    // person and "a name" to sorting, search and exports — so it is rejected.
    const message = await asUser(profileId, () =>
      expectDenied(client.query(`UPDATE groups SET name = '' WHERE id = $1`, [groupId])),
    );
    expect(message).toMatch(/groups_name_not_blank/);
  });

  it('lets a named group go back to being unnamed', async () => {
    const profileId = await createProfile('Asha');
    const groupId = await createGroup(profileId, { name: 'Goa trip' });

    await asUser(profileId, () =>
      client.query(`UPDATE groups SET name = NULL WHERE id = $1`, [groupId]),
    );
    expect((await readGroup(groupId)).name).toBeNull();
  });
});

describe('group photos', () => {
  it('stores the object path on the group', async () => {
    const profileId = await createProfile('Asha');
    const groupId = randomUUID();
    await createGroup(profileId, { groupId, photoPath: `${groupId}/cover.jpg` });

    expect((await readGroup(groupId)).photo_path).toBe(`${groupId}/cover.jpg`);
  });

  it('reads the group id out of a storage path', async () => {
    const groupId = randomUUID();
    const { rows } = await client.query(`SELECT baaki_group_from_storage_path($1) AS id`, [
      `${groupId}/cover.jpg`,
    ]);
    expect(rows[0]?.id).toBe(groupId);
  });

  it('returns null for a path that is not a group, rather than raising', async () => {
    // The storage policies call this on every object in the bucket. A malformed
    // path has to fail the policy quietly; an exception would turn somebody
    // else's bad upload into an error on this person's read.
    for (const path of ['', 'not-a-uuid/cover.jpg', '../etc/passwd', 'cover.jpg']) {
      const { rows } = await client.query(`SELECT baaki_group_from_storage_path($1) AS id`, [path]);
      expect(rows[0]?.id).toBeNull();
    }
  });
});
