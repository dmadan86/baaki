/**
 * The RPC families only server code may call.
 *
 * The storage cap ledger and the sync watermarks are SECURITY DEFINER functions
 * with no caller check in their bodies, because the edge functions that call
 * them (with the service key) have already done it. That only holds if a
 * signed-in user cannot reach them directly — which, until
 * `20260903120000_internal_rpc_grants`, they could.
 *
 * Asserted as whole sets, like the anon surface: the failure this guards
 * against is a signature change minting a new function that picks the default
 * grant back up.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { asRole, connect, expectDenied, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

/** Service-role only. Every one is definer, and none checks who is asking. */
const INTERNAL = [
  'baaki_next_capture_seq',
  'baaki_next_category_tag_seq',
  'baaki_next_ghost_merge_seq',
  'baaki_next_group_seq',
  'baaki_next_personal_seq',
  'baaki_storage_counts',
  'baaki_storage_expire_pending',
  'baaki_storage_orphan_clear',
  'baaki_storage_orphans',
  'baaki_storage_record',
  'baaki_storage_recount',
  'baaki_storage_release',
  'baaki_storage_release_reservation',
  'baaki_storage_reserve',
];

/** Trigger functions: fired by the row write, never callable, so no grant at all. */
const STAMP_TRIGGERS = [
  'baaki_stamp_capture_seq',
  'baaki_stamp_category_tag_seq',
  'baaki_stamp_ghost_merge_seq',
  'baaki_stamp_group_seq',
  'baaki_stamp_personal_seq',
  'baaki_stamp_seq',
  'baaki_storage_enqueue_orphan',
];

async function grants(names: string[]) {
  const { rows } = await client.query<{
    proname: string;
    prosecdef: boolean;
    anon: boolean;
    authenticated: boolean;
    service_role: boolean;
  }>(
    `SELECT p.proname,
            p.prosecdef,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1)
      ORDER BY 1`,
    [names],
  );
  return rows;
}

describe('the internal RPC families', () => {
  it('are reachable by service_role and by nobody else', async () => {
    const rows = await grants(INTERNAL);
    expect(rows.map((row) => row.proname)).toEqual(INTERNAL);
    for (const row of rows) {
      expect(row.prosecdef, `${row.proname} is definer`).toBe(true);
      expect(row.anon, `${row.proname} reachable by anon`).toBe(false);
      expect(row.authenticated, `${row.proname} reachable by authenticated`).toBe(false);
      expect(row.service_role, `${row.proname} reachable by service_role`).toBe(true);
    }
  });

  it('keeps the stamp triggers definer and ungranted', async () => {
    const rows = await grants(STAMP_TRIGGERS);
    expect(rows.map((row) => row.proname)).toEqual(STAMP_TRIGGERS);
    for (const row of rows) {
      expect(row.prosecdef, `${row.proname} is definer`).toBe(true);
      expect(row.anon, `${row.proname} reachable by anon`).toBe(false);
      expect(row.authenticated, `${row.proname} reachable by authenticated`).toBe(false);
    }
  });

  it('refuses a member who tries to release another object or bump a watermark', async () => {
    const group = await seedGroup(client, { memberCount: 2 });
    const claims = { sub: group.profileIds[0], role: 'authenticated' };

    const release = await asRole(client, 'authenticated', claims, () =>
      expectDenied(
        client.query(`SELECT public.baaki_storage_release('avatars', $1)`, ['x/y.webp']),
      ),
    );
    expect(release).toMatch(/permission denied/);

    const bump = await asRole(client, 'authenticated', claims, () =>
      expectDenied(client.query(`SELECT public.baaki_next_group_seq($1)`, [group.groupId])),
    );
    expect(bump).toMatch(/permission denied/);

    const reserve = await asRole(client, 'authenticated', claims, () =>
      expectDenied(
        client.query(
          `SELECT public.baaki_storage_reserve($1, NULL, 'avatars', $2, 1, 'image/webp')`,
          [group.profileIds[1], `${group.profileIds[1]}/a.webp`],
        ),
      ),
    );
    expect(reserve).toMatch(/permission denied/);
  });

  it("still stamps a member's own write through the trigger", async () => {
    // The trigger takes the sequence as its definer, so a plain RLS write by a
    // member — which is how comments arrive — keeps working with the grant gone.
    const group = await seedGroup(client, { memberCount: 2 });
    const { rows: before } = await client.query<{ updated_seq: string }>(
      `SELECT updated_seq FROM groups WHERE id = $1`,
      [group.groupId],
    );

    const { rows } = await client.query<{ updated_seq: string }>(
      `INSERT INTO activity_log (id, group_id, actor_member_id, verb, object_type, payload)
       VALUES ($1, $2, $3, 'added', 'expense', '{}'::jsonb)
       RETURNING updated_seq`,
      [randomUUID(), group.groupId, group.memberIds[0]],
    );
    expect(BigInt(rows[0]!.updated_seq)).toBeGreaterThan(BigInt(before[0]!.updated_seq));
  });
});
