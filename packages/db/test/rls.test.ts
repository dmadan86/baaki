/**
 * ADR-013 / ADR-014: the allow-deny matrix. The client is assumed hostile, so
 * every table gets an explicit "a member can" and "an outsider cannot" case,
 * plus the guest (anonymous, group-scoped) cases from ADR-006.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, asRole, connect, expectDenied, seedGroup } from './helpers.js';

let client: Client;
let group: Awaited<ReturnType<typeof seedGroup>>;
let outsiderProfileId: string;
let otherGroupId: string;

beforeAll(async () => {
  client = await connect();
  group = await seedGroup(client, { memberCount: 3, name: 'RLS trip' });
  await addEqualSplitExpense(client, {
    groupId: group.groupId,
    amount: 30000n,
    payers: { [group.memberIds[0] as string]: 30000n },
    participants: group.memberIds as string[],
  });

  const outsider = await seedGroup(client, { memberCount: 1, name: 'Someone else' });
  outsiderProfileId = outsider.profileIds[0] as string;
  otherGroupId = outsider.groupId;
});

afterAll(async () => {
  await client?.end();
});

const memberClaims = (profileId: string) => ({ sub: profileId, role: 'authenticated' });
const guestClaims = (groupIds: string[]) => ({
  sub: randomUUID(),
  role: 'anon',
  app_metadata: { baaki_groups: groupIds },
});

describe('groups', () => {
  it('a member sees their group', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const result = await client.query(`SELECT id FROM groups WHERE id = $1`, [group.groupId]);
      expect(result.rowCount).toBe(1);
    });
  });

  it('an outsider sees nothing', async () => {
    await asRole(client, 'authenticated', memberClaims(outsiderProfileId), async () => {
      const result = await client.query(`SELECT id FROM groups WHERE id = $1`, [group.groupId]);
      expect(result.rowCount).toBe(0);
    });
  });

  it('an unauthenticated caller sees nothing', async () => {
    await asRole(client, 'anon', {}, async () => {
      const result = await client.query(`SELECT id FROM groups`);
      expect(result.rowCount).toBe(0);
    });
  });
});

describe('expenses and their money rows', () => {
  it('a member reads expenses, versions, payers and shares', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[1] as string), async () => {
      for (const table of ['expenses', 'expense_versions', 'expense_payers', 'expense_shares']) {
        const result = await client.query(`SELECT * FROM ${table}`);
        expect(result.rowCount, `${table} should be readable by a member`).toBeGreaterThan(0);
      }
    });
  });

  it('an outsider reads none of them', async () => {
    await asRole(client, 'authenticated', memberClaims(outsiderProfileId), async () => {
      for (const table of ['expenses', 'expense_versions', 'expense_payers', 'expense_shares']) {
        const result = await client.query(`SELECT * FROM ${table}`);
        expect(result.rowCount, `${table} must be invisible to an outsider`).toBe(0);
      }
    });
  });

  it('an outsider cannot insert an expense into a group they are not in', async () => {
    await asRole(client, 'authenticated', memberClaims(outsiderProfileId), async () => {
      const message = await expectDenied(
        client.query(`INSERT INTO expenses (id, group_id) VALUES ($1, $2)`, [
          randomUUID(),
          group.groupId,
        ]),
      );
      expect(message).toMatch(/row-level security/i);
    });
  });

  it('a member can insert an expense', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const result = await client.query(
        `INSERT INTO expenses (id, group_id) VALUES ($1, $2) RETURNING id`,
        [randomUUID(), group.groupId],
      );
      expect(result.rowCount).toBe(1);
    });
  });
});

describe('guest sessions (ADR-006)', () => {
  it('a link guest scoped to the group can read and add an expense', async () => {
    await asRole(client, 'anon', guestClaims([group.groupId]), async () => {
      const read = await client.query(`SELECT id FROM groups WHERE id = $1`, [group.groupId]);
      expect(read.rowCount).toBe(1);

      const write = await client.query(
        `INSERT INTO expenses (id, group_id) VALUES ($1, $2) RETURNING id`,
        [randomUUID(), group.groupId],
      );
      expect(write.rowCount).toBe(1);
    });
  });

  it('a guest scoped to another group is locked out of this one', async () => {
    await asRole(client, 'anon', guestClaims([otherGroupId]), async () => {
      const read = await client.query(`SELECT id FROM groups WHERE id = $1`, [group.groupId]);
      expect(read.rowCount).toBe(0);

      const message = await expectDenied(
        client.query(`INSERT INTO expenses (id, group_id) VALUES ($1, $2)`, [
          randomUUID(),
          group.groupId,
        ]),
      );
      expect(message).toMatch(/row-level security/i);
    });
  });
});

describe('invites: mintable, never readable (TDR §2)', () => {
  it('cannot even RETURNING the row it just inserted — no SELECT policy exists', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO invites (id, group_id, token_hash, expires_at, created_by)
           VALUES ($1, $2, $3, now() + interval '7 days', $4) RETURNING id`,
          [randomUUID(), group.groupId, `hash-${randomUUID()}`, group.profileIds[0]],
        ),
      );
      expect(message).toMatch(/row-level security/i);
    });
  });

  it('a member can create an invite but cannot read any back', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const created = await client.query(
        `INSERT INTO invites (id, group_id, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, now() + interval '7 days', $4)`,
        [randomUUID(), group.groupId, `hash-${randomUUID()}`, group.profileIds[0]],
      );
      expect(created.rowCount).toBe(1);

      const read = await client.query(`SELECT * FROM invites`);
      expect(read.rowCount).toBe(0);
    });
  });
});

describe('profiles: minimal disclosure (ADR-013)', () => {
  it('you can read yourself and your co-members, nobody else', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const self = await client.query(`SELECT id FROM profiles WHERE id = $1`, [
        group.profileIds[0],
      ]);
      expect(self.rowCount).toBe(1);

      const coMember = await client.query(`SELECT id FROM profiles WHERE id = $1`, [
        group.profileIds[1],
      ]);
      expect(coMember.rowCount).toBe(1);

      const stranger = await client.query(`SELECT id FROM profiles WHERE id = $1`, [
        outsiderProfileId,
      ]);
      expect(stranger.rowCount).toBe(0);
    });
  });

  it('you cannot edit somebody else’s profile', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const result = await client.query(
        `UPDATE profiles SET display_name = 'hacked' WHERE id = $1`,
        [group.profileIds[1]],
      );
      expect(result.rowCount).toBe(0);
    });
  });
});

describe('member management', () => {
  it('a member can add a ghost', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const result = await client.query(
        `INSERT INTO group_members (id, group_id, ghost_name, joined_via)
         VALUES ($1, $2, 'Rahul', 'ghost') RETURNING id`,
        [randomUUID(), group.groupId],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it('a member cannot attach a real profile to the group — that is the claim flow', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO group_members (id, group_id, profile_id, joined_via)
           VALUES ($1, $2, $3, 'invite_link')`,
          [randomUUID(), group.groupId, outsiderProfileId],
        ),
      );
      expect(message).toMatch(/row-level security/i);
    });
  });
});

describe('derived tables are read-only to clients', () => {
  it('a member can read balances but not write them', async () => {
    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const read = await client.query(`SELECT * FROM group_balances WHERE group_id = $1`, [
        group.groupId,
      ]);
      expect(read.rowCount).toBeGreaterThan(0);

      const message = await expectDenied(
        client.query(
          `INSERT INTO group_balances (group_id, member_id, currency, balance)
           VALUES ($1, $2, 'INR', 999999)`,
          [group.groupId, group.memberIds[0]],
        ),
      );
      expect(message).toMatch(/row-level security/i);
    });
  });
});

describe('private inboxes', () => {
  it('notifications and push tokens are visible only to their owner', async () => {
    const notificationId = randomUUID();
    await client.query(
      `INSERT INTO notifications (id, profile_id, group_id, kind, title, body, channels)
       VALUES ($1, $2, $3, 'you_owe', 'Title', 'Body', ARRAY['inapp'])`,
      [notificationId, group.profileIds[0], group.groupId],
    );

    await asRole(client, 'authenticated', memberClaims(group.profileIds[0] as string), async () => {
      const mine = await client.query(`SELECT id FROM notifications WHERE id = $1`, [
        notificationId,
      ]);
      expect(mine.rowCount).toBe(1);
    });

    await asRole(client, 'authenticated', memberClaims(group.profileIds[1] as string), async () => {
      const theirs = await client.query(`SELECT id FROM notifications WHERE id = $1`, [
        notificationId,
      ]);
      expect(theirs.rowCount).toBe(0);
    });
  });
});

describe('the service role can do the privileged work (edge functions only)', () => {
  it('bypasses RLS for the ghost-claim / import paths', async () => {
    await asRole(client, 'service_role', {}, async () => {
      const result = await client.query(`SELECT count(*)::int AS count FROM groups`);
      expect(result.rows[0]?.count).toBeGreaterThan(0);
    });
  });
});
