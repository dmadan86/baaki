/**
 * Regression tests for the RPC boundary hardening (audit P0).
 *
 * These exercise the two gaps the existing suite never covered, and which is
 * exactly why they survived: it only ever called the RPCs as an authenticated
 * member or straight off the owner connection — never as `anon`, and never with
 * a settlement party from another group.
 *
 *   SEC-1: the anon key (role=anon, no `sub`) fell through the caller check and
 *          could write expenses in any group.
 *   INT-1: client-supplied shares were stored verbatim; only the sum was checked.
 *          Both are closed by revoking `baaki_apply_expense` from the client
 *          roles — the edge functions, as the service role, are the only door.
 *   INT-2: `baaki_record_settlement` never checked that the two parties belong
 *          to the settlement's group.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied } from './helpers';

let client: Client;

interface Scene {
  groupA: string;
  groupB: string;
  attackerProfile: string;
  victimProfile: string;
  outsiderProfile: string;
  attackerMemberA: string; // attacker's member id in group A
  victimMemberA: string; // another member of group A
  outsiderMemberB: string; // a member of group B — not in A
}

let scene: Scene;

/** Run `fn` as an authenticated user (a JWT with role + sub), rolled back. */
async function asAuthenticated<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: profileId, role: 'authenticated' }),
    ]);
    await client.query('SET LOCAL ROLE authenticated');
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Run `fn` as the anonymous key: role=anon, no `sub`. */
async function asAnon<T>(fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: 'anon' }),
    ]);
    await client.query('SET LOCAL ROLE anon');
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

beforeAll(async () => {
  client = await connect();

  const attackerProfile = randomUUID();
  const victimProfile = randomUUID();
  const outsiderProfile = randomUUID();
  const groupA = randomUUID();
  const groupB = randomUUID();
  const attackerMemberA = randomUUID();
  const victimMemberA = randomUUID();
  const outsiderMemberB = randomUUID();

  for (const [id, name] of [
    [attackerProfile, 'Attacker'],
    [victimProfile, 'Victim'],
    [outsiderProfile, 'Outsider'],
  ] as const) {
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, $2, 'INR')`,
      [id, name],
    );
  }
  await client.query(
    `INSERT INTO groups (id, name, type, default_currency, created_by) VALUES ($1, 'A', 'trip', 'INR', $2)`,
    [groupA, attackerProfile],
  );
  await client.query(
    `INSERT INTO groups (id, name, type, default_currency, created_by) VALUES ($1, 'B', 'trip', 'INR', $2)`,
    [groupB, outsiderProfile],
  );
  await client.query(
    `INSERT INTO group_members (id, group_id, profile_id, role, joined_via) VALUES
       ($1, $2, $3, 'member', 'created'),
       ($4, $2, $5, 'member', 'created')`,
    [attackerMemberA, groupA, attackerProfile, victimMemberA, victimProfile],
  );
  await client.query(
    `INSERT INTO group_members (id, group_id, profile_id, role, joined_via) VALUES ($1, $2, $3, 'member', 'created')`,
    [outsiderMemberB, groupB, outsiderProfile],
  );

  scene = {
    groupA,
    groupB,
    attackerProfile,
    victimProfile,
    outsiderProfile,
    attackerMemberA,
    victimMemberA,
    outsiderMemberB,
  };
});

afterAll(async () => {
  // Clean up the two groups (cascades to members); expenses were never written.
  await client.query(`DELETE FROM group_members WHERE group_id = ANY($1)`, [
    [scene.groupA, scene.groupB],
  ]);
  await client.query(`DELETE FROM groups WHERE id = ANY($1)`, [[scene.groupA, scene.groupB]]);
  await client.query(`DELETE FROM profiles WHERE id = ANY($1)`, [
    [scene.attackerProfile, scene.victimProfile, scene.outsiderProfile],
  ]);
  await client.end();
});

describe('SEC-1 / INT-1 — baaki_apply_expense is service-role only', () => {
  const call = (role: 'anon' | 'authenticated') => {
    const run = () =>
      client.query(
        `SELECT baaki_apply_expense($1, NULL, $2, 'x', NULL, current_date, 'INR', 1000,
           'equal', '{"kind":"equal"}'::jsonb, $3::jsonb, $4::jsonb, $5)`,
        [
          scene.groupA,
          scene.attackerMemberA,
          JSON.stringify([{ memberId: scene.attackerMemberA, amount: '1000' }]),
          JSON.stringify([{ memberId: scene.attackerMemberA, amount: '1000' }]),
          randomUUID(),
        ],
      );
    return role === 'anon' ? asAnon(run) : asAuthenticated(scene.attackerProfile, run);
  };

  it('refuses the anon key (the SEC-1 fail-open)', async () => {
    expect(await expectDenied(call('anon'))).toMatch(/permission denied/i);
  });

  it('refuses an authenticated member calling directly (the INT-1 forged-share door)', async () => {
    expect(await expectDenied(call('authenticated'))).toMatch(/permission denied/i);
  });
});

describe('INT-2 — settlement parties must belong to the group', () => {
  it('refuses a settlement whose counterparty is a member of another group', async () => {
    await asAuthenticated(scene.attackerProfile, async () => {
      const message = await expectDenied(
        client.query(
          `SELECT baaki_record_settlement($1, $2, $3, 5000, 'cash', 'INR', NULL, '[]'::jsonb, $4) AS id`,
          [scene.groupA, scene.attackerMemberA, scene.outsiderMemberB, randomUUID()],
        ),
      );
      expect(message).toMatch(/UNKNOWN_MEMBER/);
    });
  });

  it('still records a settlement between two members of the same group', async () => {
    await asAuthenticated(scene.attackerProfile, async () => {
      const { rows } = await client.query(
        `SELECT baaki_record_settlement($1, $2, $3, 5000, 'cash', 'INR', NULL, '[]'::jsonb, $4) AS id`,
        [scene.groupA, scene.attackerMemberA, scene.victimMemberA, randomUUID()],
      );
      expect(rows[0].id).toBeTruthy();
    });
  });

  it('refuses the anon key outright', async () => {
    await asAnon(async () => {
      const message = await expectDenied(
        client.query(
          `SELECT baaki_record_settlement($1, $2, $3, 5000, 'cash', 'INR', NULL, '[]'::jsonb, $4) AS id`,
          [scene.groupA, scene.attackerMemberA, scene.victimMemberA, randomUUID()],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });
});
