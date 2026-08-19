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

describe('the expense write RPC is not client-callable', () => {
  // Hardened after the audit: `baaki_apply_expense` is revoked from anon and
  // authenticated, so no client role reaches the function body at all — the
  // Deno edge functions (sync / expense-write) recompute the shares and call it
  // as the service role, and they are the only door. This closes the anon
  // fail-open in `baaki_assert_expense_caller` and the forged-share hole (which
  // only the SUM was ever checked against) in one move. Every client below is
  // refused at the grant, before a row is touched.
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
    await asClient(scene.outsider, async () => {
      const message = await expectDenied(
        write(scene.groupId, scene.members[0] as string, scene.members[0] as string),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses a member who has left', async () => {
    await asClient(scene.exProfile, async () => {
      const message = await expectDenied(
        write(scene.groupId, scene.exMember, scene.members[0] as string),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses even a current member calling directly, not just strangers', async () => {
    // The forged-share hole was reachable by any member, not only outsiders, so
    // the fix has to shut the door on members too — they write through the edge
    // functions, never straight into this RPC.
    await asClient(scene.profiles[0] as string, async () => {
      const message = await expectDenied(
        write(scene.groupId, scene.members[0] as string, scene.members[0] as string),
      );
      expect(message).toMatch(/permission denied/i);
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
    // Forging authorship through the RPC is now refused at the grant (the RPC is
    // service-role only); the direct-INSERT forgery above is still caught by the
    // append-only column guard.
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
      expect(message).toMatch(/permission denied/i);
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

describe('a group’s own columns are not a member’s to rewrite', () => {
  it('refuses poisoning updated_seq straight through the table', async () => {
    // `groups_update` checks membership on the row, not the columns, and the
    // sync whitelist that would have stopped this lives in the edge function —
    // a direct PATCH went around it. Setting `updated_seq` to a large number
    // jumps every member's pull cursor past all future real changes.
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(`UPDATE groups SET updated_seq = 999999 WHERE id = $1`, [scene.groupId]),
      );
      expect(message).toMatch(/FORBIDDEN_COLUMN/);
    });
  });

  it('refuses rewriting who created the group', async () => {
    await asClient(scene.profiles[1] as string, async () => {
      const message = await expectDenied(
        client.query(`UPDATE groups SET created_by = $2 WHERE id = $1`, [
          scene.groupId,
          scene.profiles[1],
        ]),
      );
      expect(message).toMatch(/FORBIDDEN_COLUMN/);
    });
  });

  it('still lets a member rename the group, and stamps the sequence itself', async () => {
    await asClient(scene.profiles[1] as string, async () => {
      const before = await client.query(`SELECT updated_seq FROM groups WHERE id = $1`, [
        scene.groupId,
      ]);
      const renamed = await client.query(`UPDATE groups SET name = 'Goa 2' WHERE id = $1`, [
        scene.groupId,
      ]);
      expect(renamed.rowCount).toBe(1);
      const after = await client.query(`SELECT updated_seq FROM groups WHERE id = $1`, [
        scene.groupId,
      ]);
      // The guard runs before the stamp trigger, so a legitimate edit still
      // gets its cursor bumped by the server.
      expect(BigInt(after.rows[0].updated_seq)).toBeGreaterThan(BigInt(before.rows[0].updated_seq));
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

  /**
   * The two the first pass missed, for the same reason and on the same
   * twenty-three tables: `GRANT ALL` was unpicked verb by verb, and these two
   * read as harmless.
   *
   * TRIGGER is not. `CREATE TRIGGER` needs the privilege on the table and
   * EXECUTE on the function and nothing else — no CREATE on the schema, which
   * these roles do not have anyway. So a member cannot write a trigger
   * function, but can attach one of Baaki's: hang the balance-maintenance
   * trigger on `expense_shares` a second time and every share counts twice.
   */
  it('lets no client attach a trigger or a foreign key to any table', async () => {
    const { rows } = await client.query(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    const allowed: string[] = [];
    for (const row of rows) {
      const table = `public.${String(row.relname)}`;
      const { rows: grant } = await client.query(
        `SELECT has_table_privilege('anon', $1, 'TRIGGER') AS at,
                has_table_privilege('authenticated', $1, 'TRIGGER') AS bt,
                has_table_privilege('anon', $1, 'REFERENCES') AS ar,
                has_table_privilege('authenticated', $1, 'REFERENCES') AS br`,
        [table],
      );
      const [held] = grant;
      if (held.at || held.bt) allowed.push(`${row.relname} TRIGGER`);
      if (held.ar || held.br) allowed.push(`${row.relname} REFERENCES`);
    }

    expect(allowed, 'a member could attach these').toEqual([]);
  });

  it('starts a table added tomorrow without them either', async () => {
    // `ALTER DEFAULT PRIVILEGES` is what stops this being rediscovered by the
    // next audit instead of prevented by this one. It applies to objects
    // created by the role that set it, which is the role Prisma migrates as.
    await client.query('CREATE TABLE public.baaki_default_privilege_probe (id int)');
    try {
      const { rows } = await client.query(
        `SELECT has_table_privilege('authenticated', 'public.baaki_default_privilege_probe', 'TRIGGER') AS t,
                has_table_privilege('authenticated', 'public.baaki_default_privilege_probe', 'REFERENCES') AS r`,
      );
      expect(rows[0].t, 'TRIGGER on a new table').toBe(false);
      expect(rows[0].r, 'REFERENCES on a new table').toBe(false);
    } finally {
      await client.query('DROP TABLE public.baaki_default_privilege_probe');
    }
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
