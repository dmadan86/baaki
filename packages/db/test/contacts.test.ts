/**
 * Adding somebody by email or number (ADR-006).
 *
 * The failure worth testing for is not a rejected address — it is the same
 * human becoming two members. Picking from a contact list makes that easy: the
 * same person is in there twice, or was added by hand last week and picked from
 * contacts today. Two ghosts for one person split their balance in half, and
 * nothing downstream can tell that happened.
 *
 * The other half is normalisation. It lives in the database rather than the
 * client because the offline queue means an old build's idea of what an email
 * looks like can arrive months late (ADR-005).
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

async function seedGroup(): Promise<string> {
  const profileId = randomUUID();
  await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Asha')`, [profileId]);
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query(`SET ROLE authenticated`);
  const { rows } = await client.query(
    `SELECT baaki_create_group('Trip', 'trip', 'INR', NULL, true, NULL, NULL) AS id`,
  );
  return String(rows[0].id);
}

async function reset(): Promise<void> {
  await client.query(`RESET ROLE`);
  await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
}

async function add(
  groupId: string,
  name: string | null,
  email: string | null = null,
  phone: string | null = null,
): Promise<{ id?: string; error?: string }> {
  try {
    const { rows } = await client.query(
      `SELECT baaki_add_ghost_member($1::uuid, $2::text, NULL::uuid, $3::text, $4::text) AS id`,
      [groupId, name, email, phone],
    );
    return { id: String(rows[0].id) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function read(memberId: string) {
  const { rows } = await client.query(
    `SELECT ghost_name, invite_email, invite_phone, joined_via
       FROM group_members WHERE id = $1`,
    [memberId],
  );
  return rows[0];
}

describe('adding somebody by email', () => {
  it('stores the address, lowercased', async () => {
    const groupId = await seedGroup();
    const { id } = await add(groupId, 'Ravi', '  Ravi@Example.COM ');
    const member = await read(id as string);

    expect(member.invite_email).toBe('ravi@example.com');
    expect(member.ghost_name).toBe('Ravi');
    expect(member.joined_via).toBe('ghost');
    await reset();
  });

  it('falls back to the address when no name was given', async () => {
    // Picking an email out of a contact card often carries no usable name.
    const groupId = await seedGroup();
    const { id } = await add(groupId, null, 'ravi@example.com');
    expect((await read(id as string)).ghost_name).toBe('ravi@example.com');
    await reset();
  });

  it('refuses something that is not an address', async () => {
    const groupId = await seedGroup();
    for (const bad of ['ravi', 'ravi@', '@example.com', 'a b@example.com', 'ravi@example']) {
      const { error } = await add(groupId, 'Ravi', bad);
      expect(error).toMatch(/invite_email_shape/);
    }
    await reset();
  });
});

describe('adding somebody from contacts', () => {
  it('keeps a number in E.164', async () => {
    const groupId = await seedGroup();
    const { id } = await add(groupId, 'Ravi', null, '+91 98765 43210');
    expect((await read(id as string)).invite_phone).toBe('+919876543210');
    await reset();
  });

  it('strips the punctuation a contact card carries', async () => {
    const groupId = await seedGroup();
    const { id } = await add(groupId, 'Ravi', null, '+91-98765-43210');
    expect((await read(id as string)).invite_phone).toBe('+919876543210');
    await reset();
  });

  it('refuses a number with no country code rather than assuming India', async () => {
    // Somebody on a trip is exactly the person whose contacts are foreign, so
    // defaulting to +91 would silently invite a stranger in another country.
    const groupId = await seedGroup();
    const { error } = await add(groupId, 'Ravi', null, '09876543210');
    expect(error).toMatch(/PHONE_NEEDS_COUNTRY_CODE/);
    await reset();
  });

  it('refuses a number that is not a number', async () => {
    const groupId = await seedGroup();
    const { error } = await add(groupId, 'Ravi', null, '+12');
    expect(error).toMatch(/invite_phone_e164/);
    await reset();
  });
});

describe('the same person must not become two members', () => {
  it('returns the existing member when the email is already there', async () => {
    const groupId = await seedGroup();
    const first = await add(groupId, 'Ravi', 'ravi@example.com');
    const again = await add(groupId, 'Ravi Kumar', 'ravi@example.com');

    expect(again.id).toBe(first.id);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM group_members WHERE group_id = $1 AND ghost_name IS NOT NULL`,
      [groupId],
    );
    expect(rows[0].n).toBe(1);
    await reset();
  });

  it('matches through a differently-typed address', async () => {
    const groupId = await seedGroup();
    const first = await add(groupId, 'Ravi', 'ravi@example.com');
    const again = await add(groupId, 'Ravi', ' RAVI@Example.com ');
    expect(again.id).toBe(first.id);
    await reset();
  });

  it('matches through a differently-typed number', async () => {
    const groupId = await seedGroup();
    const first = await add(groupId, 'Ravi', null, '+919876543210');
    const again = await add(groupId, 'Ravi', null, '+91 98765-43210');
    expect(again.id).toBe(first.id);
    await reset();
  });

  it('still allows two different people with the same name', async () => {
    // Matched on contact, not name — two people really are called Ravi.
    const groupId = await seedGroup();
    const first = await add(groupId, 'Ravi', 'ravi.k@example.com');
    const second = await add(groupId, 'Ravi', 'ravi.s@example.com');
    expect(second.id).not.toBe(first.id);
    await reset();
  });
});

describe('who may add', () => {
  it('refuses somebody who is not in the group', async () => {
    const groupId = await seedGroup();
    await reset();

    const outsider = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Nobody')`, [outsider]);
    await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: outsider, role: 'authenticated' }),
    ]);
    await client.query(`SET ROLE authenticated`);

    const { error } = await add(groupId, 'Ravi', 'ravi@example.com');
    expect(error).toMatch(/NOT_A_MEMBER/);
    await reset();
  });

  it('refuses an entry with nothing in it at all', async () => {
    const groupId = await seedGroup();
    const { error } = await add(groupId, '   ', '', '');
    expect(error).toMatch(/NOTHING_TO_ADD/);
    await reset();
  });
});
