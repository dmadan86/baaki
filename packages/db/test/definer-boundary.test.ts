/**
 * Boundary tests for the SECURITY DEFINER mutators whose `anon`/PUBLIC grant was
 * closed by 20260825240000_definer_anon_grant_audit.
 *
 * The migration removes anon's ability to even *reach* these functions; each
 * also self-gates on the caller's membership/party/admin status. These tests pin
 * both halves at the database — the layer that actually enforces them — across
 * the five callers the audit brief named:
 *
 *   • anon (no JWT `sub`)                       → permission denied (no EXECUTE)
 *   • guest / outsider (authenticated non-member) → the function's own refusal
 *   • member                                     → allowed
 *   • cross-group (a member of A acting on B's object) → refused
 *
 * A Supabase GUEST is an anonymous *sign-in*: it runs as role `authenticated`
 * with a real `sub`, so at the database it is indistinguishable from any other
 * authenticated non-member — which is exactly the "outsider" column. Both are
 * covered by the authenticated-non-member cases below.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, connect, expectDenied, seedGroup } from './helpers.js';
import type { SeededGroup } from './helpers.js';

let client: Client;

interface Scene {
  A: SeededGroup;
  B: SeededGroup;
  /** An authenticated user who is a member of no group (a fresh guest/outsider). */
  outsiderProfile: string;
  objA: Objects;
  objB: Objects;
}
interface Objects {
  attachmentId: string;
  proofId: string;
  photoId: string;
  planItemId: string;
  ghostIds: [string, string];
}

let scene: Scene;

/** BEGIN…ROLLBACK as the anonymous key: role=anon, no `sub`. */
async function asAnon<T>(run: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: 'anon' }),
    ]);
    await client.query('SET LOCAL ROLE anon');
    return await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** BEGIN…ROLLBACK as an authenticated user (JWT with role + sub). */
async function asAuth<T>(profileId: string, run: () => Promise<T>): Promise<T> {
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

async function seedObjects(group: SeededGroup): Promise<Objects> {
  const payer = group.memberIds[0]!; // members[0] is admin
  const other = group.memberIds[1]!; // [1] a plain member
  const ghostIds: [string, string] = [group.memberIds[2]!, group.memberIds[3]!];

  const { expenseId } = await addEqualSplitExpense(client, {
    groupId: group.groupId,
    payers: { [payer]: 1000n },
    participants: [payer, other],
    amount: 1000n,
  });

  const attachmentId = randomUUID();
  await client.query(
    `INSERT INTO expense_attachments (id, expense_id, group_id, uploader_member_id, storage_path, visibility)
     VALUES ($1, $2, $3, $4, $5, 'group')`,
    [attachmentId, expenseId, group.groupId, payer, `${expenseId}/a.webp`],
  );

  const settlementId = randomUUID();
  await client.query(
    `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, method, currency, status)
     VALUES ($1, $2, $3, $4, 500, 'cash', 'INR', 'confirmed')`,
    [settlementId, group.groupId, payer, other],
  );
  const proofId = randomUUID();
  await client.query(
    `INSERT INTO settlement_proofs (id, settlement_id, group_id, uploader_member_id, storage_path)
     VALUES ($1, $2, $3, $4, $5)`,
    [proofId, settlementId, group.groupId, payer, `${settlementId}/p.webp`],
  );

  const photoId = randomUUID();
  await client.query(
    `INSERT INTO trip_photos (id, group_id, storage_path, created_by) VALUES ($1, $2, $3, $4)`,
    [photoId, group.groupId, `${group.groupId}/photo.webp`, payer],
  );

  const planItemId = randomUUID();
  await client.query(
    `INSERT INTO trip_plan_items (id, group_id, day, title, created_by)
     VALUES ($1, $2, current_date, 'Dudhsagar falls', $3)`,
    [planItemId, group.groupId, payer],
  );

  return { attachmentId, proofId, photoId, planItemId, ghostIds };
}

beforeAll(async () => {
  client = await connect();
  const A = await seedGroup(client, { memberCount: 2, ghostCount: 2, name: 'Group A' });
  const B = await seedGroup(client, { memberCount: 2, ghostCount: 2, name: 'Group B' });
  const outsiderProfile = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Outsider', 'INR')`,
    [outsiderProfile],
  );
  const objA = await seedObjects(A);
  const objB = await seedObjects(B);
  scene = { A, B, outsiderProfile, objA, objB };
});

afterAll(async () => {
  if (!scene) return;
  const groupIds = [scene.A.groupId, scene.B.groupId];
  const profileIds = [...scene.A.profileIds, ...scene.B.profileIds, scene.outsiderProfile];
  // The ledger tables are append-only / no-hard-delete (ADR-004), and those
  // guards fire even for the owner connection. `session_replication_role =
  // replica` (session-local, only this connection) suspends user triggers —
  // and with them FK cascades — so teardown deletes each table explicitly,
  // children before parents.
  await client.query(`SET session_replication_role = replica`);
  try {
    const inGroups = (col: string) => `${col} = ANY($1)`;
    const versionScope = `expense_version_id IN (SELECT v.id FROM expense_versions v
      JOIN expenses e ON e.id = v.expense_id WHERE ${inGroups('e.group_id')})`;
    await client.query(`DELETE FROM expense_payers WHERE ${versionScope}`, [groupIds]);
    await client.query(`DELETE FROM expense_shares WHERE ${versionScope}`, [groupIds]);
    await client.query(`DELETE FROM expense_attachments WHERE ${inGroups('group_id')}`, [groupIds]);
    await client.query(`DELETE FROM settlement_proofs WHERE ${inGroups('group_id')}`, [groupIds]);
    await client.query(`DELETE FROM trip_photos WHERE ${inGroups('group_id')}`, [groupIds]);
    await client.query(`DELETE FROM trip_plan_items WHERE ${inGroups('group_id')}`, [groupIds]);
    await client.query(`DELETE FROM activity_log WHERE ${inGroups('group_id')}`, [groupIds]);
    await client.query(
      `DELETE FROM expense_versions WHERE expense_id IN (SELECT id FROM expenses WHERE ${inGroups('group_id')})`,
      [groupIds],
    );
    await client.query(`DELETE FROM expenses WHERE ${inGroups('group_id')}`, [groupIds]);
    await client.query(`DELETE FROM settlements WHERE ${inGroups('group_id')}`, [groupIds]);
    await client.query(`DELETE FROM group_members WHERE ${inGroups('group_id')}`, [groupIds]);
    await client.query(`DELETE FROM groups WHERE ${inGroups('id')}`, [groupIds]);
    await client.query(`DELETE FROM profiles WHERE id = ANY($1)`, [profileIds]);
  } finally {
    await client.query(`SET session_replication_role = origin`);
  }
  await client.end();
});

/**
 * One row per prioritized RPC. `call(obj, group)` builds the query for a target
 * group's object; `memberActor(group)` picks a legitimate caller; `refuse` is
 * the pattern the function raises for an authenticated non-party/non-member.
 */
interface Case {
  name: string;
  call: (obj: Objects, group: SeededGroup) => Promise<unknown>;
  memberActor: (group: SeededGroup) => string; // profile id of an allowed caller
  refuse: RegExp;
}

const q = (sql: string, params: unknown[]) => client.query(sql, params);

const cases: Case[] = [
  {
    name: 'baaki_remove_expense_attachment (attachment removal)',
    call: (o) => q(`SELECT baaki_remove_expense_attachment($1)`, [o.attachmentId]),
    memberActor: (g) => g.profileIds[0]!, // the payer/author is a party
    refuse: /NOT_A_PARTY/,
  },
  {
    name: 'baaki_remove_settlement_proof (proof removal)',
    call: (o) => q(`SELECT baaki_remove_settlement_proof($1)`, [o.proofId]),
    memberActor: (g) => g.profileIds[0]!,
    refuse: /NOT_A_PARTY/,
  },
  {
    name: 'baaki_remove_trip_photo (album photo removal)',
    call: (o) => q(`SELECT baaki_remove_trip_photo($1)`, [o.photoId]),
    memberActor: (g) => g.profileIds[1]!, // any member may
    refuse: /NOT_A_MEMBER/,
  },
  {
    name: 'baaki_remove_plan_item (plan item removal)',
    call: (o) => q(`SELECT baaki_remove_plan_item($1)`, [o.planItemId]),
    memberActor: (g) => g.profileIds[1]!,
    refuse: /NOT_A_MEMBER/,
  },
  {
    name: 'baaki_merge_ghosts (merge ghosts)',
    call: (o) => q(`SELECT baaki_merge_ghosts($1::uuid[], 'Priya')`, [o.ghostIds]),
    memberActor: (g) => g.profileIds[0]!,
    refuse: /NOT_MERGEABLE/,
  },
  {
    name: 'baaki_reset_group_join_token (join-token reset, admin-only)',
    call: (_o, g) => q(`SELECT baaki_reset_group_join_token($1)`, [g.groupId]),
    memberActor: (g) => g.profileIds[0]!, // admin
    refuse: /ADMIN_ONLY/,
  },
  {
    name: 'baaki_import_ledger (import RPC)',
    call: (_o, g) =>
      q(`SELECT baaki_import_ledger($1, $2::jsonb, '[]'::jsonb, '[]'::jsonb, 'test')`, [
        g.groupId,
        JSON.stringify([{ name: 'Imported ghost', memberId: null }]),
      ]),
    memberActor: (g) => g.profileIds[0]!,
    refuse: /NOT_A_MEMBER/,
  },
];

describe.each(cases)('$name', ({ call, memberActor, refuse }) => {
  it('anon (no subject) → permission denied', async () => {
    const message = await expectDenied(asAnon(() => call(scene.objA, scene.A)));
    expect(message).toMatch(/permission denied/i);
  });

  it('guest / outsider (authenticated non-member) → refused', async () => {
    const message = await expectDenied(
      asAuth(scene.outsiderProfile, () => call(scene.objA, scene.A)),
    );
    expect(message).toMatch(refuse);
  });

  it('member → allowed', async () => {
    await asAuth(memberActor(scene.A), async () => {
      await expect(call(scene.objA, scene.A)).resolves.toBeDefined();
    });
  });

  it('cross-group (member of A acting on B) → refused', async () => {
    // The actor is a legitimate caller in A, but the object/target is B's.
    const message = await expectDenied(
      asAuth(memberActor(scene.A), () => call(scene.objB, scene.B)),
    );
    expect(message).toMatch(refuse);
  });
});

/**
 * baaki_ensure_group_join_token is member-level (not admin), so it gets the same
 * matrix but with NOT_A_MEMBER as the refusal and any member allowed.
 */
describe('baaki_ensure_group_join_token (durable join link, member-level)', () => {
  const call = (groupId: string) => q(`SELECT baaki_ensure_group_join_token($1)`, [groupId]);

  it('anon (no subject) → permission denied', async () => {
    const message = await expectDenied(asAnon(() => call(scene.A.groupId)));
    expect(message).toMatch(/permission denied/i);
  });
  it('guest / outsider → NOT_A_MEMBER', async () => {
    const message = await expectDenied(asAuth(scene.outsiderProfile, () => call(scene.A.groupId)));
    expect(message).toMatch(/NOT_A_MEMBER/);
  });
  it('member → allowed', async () => {
    await asAuth(scene.A.profileIds[1]!, async () => {
      await expect(call(scene.A.groupId)).resolves.toBeDefined();
    });
  });
  it('cross-group (member of A on B) → NOT_A_MEMBER', async () => {
    const message = await expectDenied(asAuth(scene.A.profileIds[0]!, () => call(scene.B.groupId)));
    expect(message).toMatch(/NOT_A_MEMBER/);
  });
});
