/**
 * The attacks, kept.
 *
 * Every case below is something that worked against the deployed schema on
 * 2026-08-07 — run as an ordinary member, a former member, or somebody who had
 * never been in the group at all, straight through PostgREST with no stolen
 * key. They are here rather than in a report because a report does not fail
 * the build when somebody adds a policy back.
 *
 * The defect they share: `is_group_member()` answers "may you touch this
 * group", and it was being used to answer "is this row about you".
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied } from './helpers';

let client: Client;

/** A group with two real members, plus the two kinds of stranger. */
interface Scene {
  groupId: string;
  profiles: string[];
  members: string[];
  expenseId: string;
  settlementId: string;
  /** Was a member, left. Still knows the group id and their own member id. */
  exProfile: string;
  exMember: string;
  /** Never a member. Has seen one member id — an export, a screenshot. */
  outsider: string;
}

let scene: Scene;

async function asClient<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: profileId, role: 'authenticated' }),
    ]);
    await client.query('SET LOCAL ROLE authenticated');
    return await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

beforeAll(async () => {
  client = await connect();

  const profiles = [randomUUID(), randomUUID()];
  const members = [randomUUID(), randomUUID()];
  const groupId = randomUUID();

  for (const [index, profileId] of profiles.entries()) {
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, $2, 'INR')`,
      [profileId, `Person ${index + 1}`],
    );
  }
  await client.query(
    `INSERT INTO groups (id, name, type, default_currency, created_by) VALUES ($1, 'Goa', 'trip', 'INR', $2)`,
    [groupId, profiles[0]],
  );
  for (const [index, memberId] of members.entries()) {
    await client.query(
      `INSERT INTO group_members (id, group_id, profile_id, role, joined_via)
       VALUES ($1, $2, $3, 'member', 'created')`,
      [memberId, groupId, profiles[index]],
    );
  }

  // Person 1 paid 20000, split evenly. Person 2 owes 10000 — the debt every
  // attack below is trying to make disappear.
  const applied = await client.query(
    `SELECT baaki_apply_expense($1, NULL, $2, 'Dinner', NULL, current_date, 'INR', 20000,
       'equal', '{"kind":"equal"}'::jsonb, $3::jsonb, $4::jsonb, $5) AS out`,
    [
      groupId,
      members[0],
      JSON.stringify([{ memberId: members[0], amount: '20000' }]),
      JSON.stringify(members.map((memberId) => ({ memberId, amount: '10000' }))),
      randomUUID(),
    ],
  );

  const settlementId = randomUUID();
  await client.query(
    `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method, status)
     VALUES ($1, $2, $3, $4, 'INR', 5000, 'upi', 'initiated')`,
    [settlementId, groupId, members[1], members[0]],
  );

  const exProfile = randomUUID();
  const exMember = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Ex', 'INR')`,
    [exProfile],
  );
  await client.query(
    `INSERT INTO group_members (id, group_id, profile_id, role, joined_via, left_at)
     VALUES ($1, $2, $3, 'member', 'invite', now())`,
    [exMember, groupId, exProfile],
  );

  const outsider = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Mallory', 'INR')`,
    [outsider],
  );

  scene = {
    groupId,
    profiles,
    members,
    expenseId: String((applied.rows[0].out as { expenseId: string }).expenseId),
    settlementId,
    exProfile,
    exMember,
    outsider,
  };
});

afterAll(async () => {
  await client.end();
});

describe('a member cannot pay a debt by saying they did', () => {
  it('refuses a settlement written straight into the table', async () => {
    // This one erased a real debt: both balances went to zero, with no payment
    // and no confirmation from the person owed. `settlements_insert` checked
    // group membership and nothing else, and the transition guard reads OLD so
    // it never saw an INSERT arriving at 'confirmed'.
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method, status, confirmed_at)
           VALUES ($1, $2, $3, $4, 'INR', 10000, 'upi', 'confirmed', now())`,
          [randomUUID(), scene.groupId, scene.members[1], scene.members[0]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses confirming a settlement by updating the row', async () => {
    // The same hole by another route: `baaki_confirm_settlement` refuses
    // anybody but the payee, and a direct UPDATE went around it.
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(`UPDATE settlements SET status = 'confirmed' WHERE id = $1`, [
          scene.settlementId,
        ]),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('still lets the two RPCs do their jobs', async () => {
    await asClient(scene.profiles[1] as string, async () => {
      const recorded = await client.query(
        `SELECT baaki_record_settlement($1, $2, $3, 4000, 'upi', 'INR', NULL, NULL, $4) AS id`,
        [scene.groupId, scene.members[1], scene.members[0], randomUUID()],
      );
      expect(recorded.rows[0].id).toBeTruthy();
    });
    await asClient(scene.profiles[0] as string, async () => {
      await client.query(`SELECT baaki_confirm_settlement($1)`, [scene.settlementId]);
      const { rows } = await client.query(`SELECT status FROM settlements WHERE id = $1`, [
        scene.settlementId,
      ]);
      expect(rows[0].status).toBe('confirmed');
    });
  });
});

describe('a stranger cannot write into a group', () => {
  const write = (groupId: string, authorMemberId: string, payerMemberId: string) =>
    client.query(
      `SELECT baaki_apply_expense($1, NULL, $2, 'Injected', NULL, current_date, 'INR', 60000,
         'equal', '{"kind":"equal"}'::jsonb, $3::jsonb, $4::jsonb, $5)`,
      [
        groupId,
        authorMemberId,
        JSON.stringify([{ memberId: payerMemberId, amount: '60000' }]),
        JSON.stringify([{ memberId: payerMemberId, amount: '60000' }]),
        randomUUID(),
      ],
    );

  it('refuses somebody who has never been a member', async () => {
    // `baaki_apply_expense` is SECURITY DEFINER and checked that the member ids
    // it was handed belonged to the group — never that the caller did. This
    // committed a ₹600 expense into a stranger's group and moved every balance.
    await asClient(scene.outsider, async () => {
      const message = await expectDenied(
        write(scene.groupId, scene.members[0] as string, scene.members[0] as string),
      );
      expect(message).toMatch(/NOT_A_MEMBER/);
    });
  });

  it('refuses a member who has left', async () => {
    // The easy case: no leaked id needed, only their own. `left_at` stops
    // `is_group_member`, and this function never asked it.
    await asClient(scene.exProfile, async () => {
      const message = await expectDenied(
        write(scene.groupId, scene.exMember, scene.members[0] as string),
      );
      expect(message).toMatch(/NOT_A_MEMBER/);
    });
  });

  it('lets a member write, as themselves', async () => {
    await asClient(scene.profiles[0] as string, async () => {
      const result = await write(
        scene.groupId,
        scene.members[0] as string,
        scene.members[0] as string,
      );
      expect(result.rowCount).toBe(1);
    });
  });
});

describe('nobody writes history in somebody else’s name', () => {
  it('refuses an activity entry attributed to another member', async () => {
    // `activity_log` is append-only, so a forged "Priya settled up" could never
    // be taken back out by anyone but the service role.
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO activity_log (id, group_id, actor_member_id, verb, object_type, object_id, payload)
           VALUES ($1, $2, $3, 'settled', 'group', $2, '{}'::jsonb)`,
          [randomUUID(), scene.groupId, scene.members[0]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses an expense version authored by another member', async () => {
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO expense_versions (id, expense_id, version_no, author_member_id, description,
             expense_date, currency, amount, split_type, split_params, source)
           VALUES ($1, $2, 9, $3, 'Forged', current_date, 'INR', 100, 'equal', '{"kind":"equal"}'::jsonb, 'manual')`,
          [randomUUID(), scene.expenseId, scene.members[0]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses an expense recorded as written by somebody else', async () => {
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(
          `SELECT baaki_apply_expense($1, NULL, $2, 'Not mine', NULL, current_date, 'INR', 6000,
             'equal', '{"kind":"equal"}'::jsonb, $3::jsonb, $4::jsonb, $5)`,
          [
            scene.groupId,
            scene.members[0], // somebody else
            JSON.stringify([{ memberId: scene.members[0], amount: '6000' }]),
            JSON.stringify([{ memberId: scene.members[0], amount: '6000' }]),
            randomUUID(),
          ],
        ),
      );
      expect(message).toMatch(/NOT_THE_AUTHOR/);
    });
  });
});

describe('a membership is not yours to rewrite', () => {
  it('refuses promoting yourself to admin', async () => {
    // `UPDATE group_members SET role='admin'` on your own row worked, and
    // `is_group_admin()` agreed with it afterwards.
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(`UPDATE group_members SET role = 'admin' WHERE id = $1`, [scene.members[1]]),
      );
      expect(message).toMatch(/FORBIDDEN_COLUMN/);
    });
  });

  it('refuses moving a membership to another group', async () => {
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(`UPDATE group_members SET group_id = $2 WHERE id = $1`, [
          scene.members[1],
          randomUUID(),
        ]),
      );
      expect(message).toMatch(/FORBIDDEN_COLUMN/);
    });
  });

  it('still lets somebody set their own VPA and leave', async () => {
    await asClient(scene.profiles[1] as string, async () => {
      await client.query(`UPDATE group_members SET vpa = 'me@upi' WHERE id = $1`, [
        scene.members[1],
      ]);
      const left = await client.query(`UPDATE group_members SET left_at = now() WHERE id = $1`, [
        scene.members[1],
      ]);
      expect(left.rowCount).toBe(1);
    });
  });
});

describe('the parts of the database that are nobody’s business', () => {
  it('hides the migration ledger', async () => {
    // Prisma creates this table outside the migration that turns RLS on, so it
    // was the one table in `public` with RLS off while Supabase's blanket
    // GRANT still applied. Anyone holding the anon key — which ships in every
    // binary — could read it and delete it.
    await asClient(scene.outsider, async () => {
      const message = await expectDenied(client.query(`SELECT count(*) FROM _prisma_migrations`));
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses to recompute a stranger’s balances on demand', async () => {
    await asClient(scene.outsider, async () => {
      const message = await expectDenied(
        client.query(`SELECT baaki_refresh_group_balances($1)`, [scene.groupId]),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  /**
   * The one that would have taken everything.
   *
   * TRUNCATE is not a filtered DELETE — row-level security does not apply to
   * it at all. Supabase's default `GRANT ALL ON ALL TABLES IN SCHEMA public`
   * includes it, so on the deployed project any signed-in user, and
   * `signInAnonymously()` means anybody, could have emptied `group_members`
   * and taken every group and balance in the database with it, without a
   * single policy being consulted.
   *
   * Asserted over every table rather than a list, because the danger is a
   * table added later: a new one arrives with the default grants again, and
   * this is what notices.
   */
  it('lets no client truncate any table in public', async () => {
    const { rows } = await client.query(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    const truncatable = rows
      .map((row) => String(row.relname))
      .filter((table) => table !== undefined);

    const allowed: string[] = [];
    for (const table of truncatable) {
      const { rows: grant } = await client.query(
        `SELECT has_table_privilege('anon', $1, 'TRUNCATE') AS a,
                has_table_privilege('authenticated', $1, 'TRUNCATE') AS b`,
        [`public.${table}`],
      );
      if (grant[0].a || grant[0].b) allowed.push(table);
    }

    expect(allowed, 'these tables can be emptied by any signed-in user').toEqual([]);
  });

  it('gives a JWT claim naming a group no power at all', async () => {
    // `is_group_member` used to accept any group id in
    // `app_metadata.baaki_groups`. Nothing ever wrote that claim, and it had
    // no expiry and no way to revoke. Membership is a row.
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({
          sub: scene.outsider,
          role: 'authenticated',
          app_metadata: { baaki_groups: [scene.groupId] },
        }),
      ]);
      await client.query('SET LOCAL ROLE authenticated');
      const { rows } = await client.query(`SELECT is_group_member($1) AS member`, [scene.groupId]);
      expect(rows[0].member).toBe(false);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
