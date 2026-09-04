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
// A guest session as Supabase actually issues one: the `authenticated` role and
// an `is_anonymous` claim, carrying the group ids the removed claim mechanism
// used to honour. The point of these cases is that the claim buys nothing —
// only a `group_members` row does.
const guestClaims = (groupIds: string[]) => ({
  sub: randomUUID(),
  role: 'authenticated',
  is_anonymous: true,
  app_metadata: { waves_groups: groupIds },
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

  it('an unauthenticated caller cannot even address the table', async () => {
    // Stronger than "sees no rows", which is what RLS alone gave: since
    // 20260831120000_anon_surface_hardening the signed-out role holds no grant
    // on `groups` at all, so the read is refused before a policy is consulted
    // and the table is not published in the API schema either.
    await asRole(client, 'anon', {}, async () => {
      const message = await expectDenied(client.query(`SELECT id FROM groups`));
      expect(message).toMatch(/permission denied/i);
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

  /**
   * Nobody signed in may write these tables by hand any more — not an
   * outsider, and not a member either (20260807090000_security_hardening).
   *
   * A member writing `expenses` directly was allowed until an attack found
   * what it also allowed: an `expense_versions` row naming somebody else as
   * its author, permanently, because those rows are append-only. The privilege
   * that let a member do the harmless version of that is the same privilege,
   * so it is gone. `waves_apply_expense` is the way in, and it stamps the
   * author itself.
   */
  it('nobody writes the ledger tables by hand — not even a member', async () => {
    for (const profileId of [outsiderProfileId, group.profileIds[0] as string]) {
      await asRole(client, 'authenticated', memberClaims(profileId), async () => {
        const message = await expectDenied(
          client.query(`INSERT INTO expenses (id, group_id) VALUES ($1, $2)`, [
            randomUUID(),
            group.groupId,
          ]),
        );
        expect(message).toMatch(/permission denied/i);
      });
    }
  });

  it('no client role calls the expense write RPC directly — not even a member', async () => {
    // Hardened after the audit: `waves_apply_expense` is service-role only, so
    // the Deno edge functions (which recompute the shares) are the one door.
    // Both a member and an outsider are refused at the grant — this closes the
    // anon fail-open and the forged-share hole together.
    const payers = JSON.stringify([{ memberId: group.memberIds[0], amount: '9000' }]);
    const shares = JSON.stringify(
      (group.memberIds as string[]).slice(0, 3).map((memberId) => ({ memberId, amount: '3000' })),
    );
    const call = `SELECT waves_apply_expense($1, NULL, $2, 'Chai', NULL, current_date, 'INR',
      9000, 'equal', '{"kind":"equal"}'::jsonb, $3::jsonb, $4::jsonb, $5)`;

    for (const profileId of [group.profileIds[0] as string, outsiderProfileId]) {
      await asRole(client, 'authenticated', memberClaims(profileId), async () => {
        const message = await expectDenied(
          client.query(call, [group.groupId, group.memberIds[0], payers, shares, randomUUID()]),
        );
        expect(message).toMatch(/permission denied/i);
      });
    }
  });
});

/**
 * ADR-006 promises anonymous write access "scoped strictly to the invited
 * group". It is — by the `group_members` row that `invite-accept` writes when
 * a guest joins, which is the same row every other member has.
 *
 * A second mechanism used to exist alongside it: `is_group_member` also
 * accepted any group id listed in the JWT's `app_metadata.waves_groups`.
 * Nothing in this repository has ever written that claim, and it had no
 * expiry and no way to revoke — leaving the group, revoking the invite and
 * deleting the member row would all have failed to remove it. Removed in
 * 20260807090000_security_hardening. Membership is a row.
 */
describe('guest sessions (ADR-006)', () => {
  it('a guest who joined is a member, and reads the group', async () => {
    // A guest is an anonymous *sign-in*, which Supabase issues as a real JWT
    // carrying the `authenticated` role and an `is_anonymous` claim — not the
    // `anon` API-key role, which means "no session at all". Modelled as `anon`
    // this case was really testing the signed-out grant; it is the guest's
    // membership row that has always done the work.
    await asRole(client, 'authenticated', memberClaims(group.profileIds[1] as string), async () => {
      const read = await client.query(`SELECT id FROM groups WHERE id = $1`, [group.groupId]);
      expect(read.rowCount).toBe(1);
    });
  });

  it('a JWT claim naming a group grants nothing on its own', async () => {
    await asRole(client, 'authenticated', guestClaims([group.groupId]), async () => {
      expect(
        (await client.query(`SELECT is_group_member($1) AS m`, [group.groupId])).rows[0].m,
      ).toBe(false);
      const read = await client.query(`SELECT id FROM groups WHERE id = $1`, [group.groupId]);
      expect(read.rowCount).toBe(0);
    });
  });

  it('and a claim naming somebody else’s group grants nothing either', async () => {
    await asRole(client, 'authenticated', guestClaims([otherGroupId]), async () => {
      const read = await client.query(`SELECT id FROM groups WHERE id = $1`, [group.groupId]);
      expect(read.rowCount).toBe(0);
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
