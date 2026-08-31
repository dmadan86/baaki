/**
 * What a signed-out request can even address.
 *
 * RLS decides which rows come back; these are the grants that decide whether
 * the question can be asked at all. They are asserted as whole sets rather than
 * one table at a time, because the failure this guards against is *addition*: a
 * later migration that creates a function or a table and quietly hands `anon`
 * the default grant. A per-item test would never notice the new thing.
 *
 * The trap is worth stating, since the repo already fell into it once. Supabase
 * ships default privileges on `public` that grant EXECUTE **directly to `anon`**
 * as each function is created, so the familiar
 *
 *     REVOKE ALL ON FUNCTION ... FROM PUBLIC;
 *
 * does not close it — a direct grant is not the PUBLIC one. Every function
 * added after the definer-grant audit was reachable signed-out again for
 * exactly that reason (`20260831120000_anon_surface_hardening`). The house
 * pattern is `FROM PUBLIC, anon`, and this file is what enforces it.
 */

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

/**
 * The RLS helpers the policies themselves call. A policy written
 * `TO anon, authenticated` has to be able to evaluate for either role, so these
 * stay reachable signed-out — they answer "is this caller a member", which for
 * a signed-out caller is always false.
 */
const POLICY_HELPERS = [
  'baaki_is_expense_party',
  'baaki_is_settlement_party',
  'baaki_my_member_id',
  'baaki_version_group_id',
  'is_group_member',
];

/**
 * The three things that have to answer before there is a session: the version
 * gate the app reads before its own sign-in screen, the country denylist on the
 * phone sign-in screen, and public feature configuration.
 */
const PRE_SIGN_IN_TABLES = ['app_releases', 'country_settings', 'feature_flags'];

describe('the signed-out surface', () => {
  it('exposes exactly the RLS helpers, and no other SECURITY DEFINER function', async () => {
    const { rows } = await client.query<{ proname: string }>(`
      SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
       ORDER BY 1
    `);

    // Named in the failure so a new arrival is obvious: if this trips, a
    // migration created a definer function and left it callable signed-out.
    expect(rows.map((row) => row.proname)).toEqual(POLICY_HELPERS);
  });

  it('exposes exactly the three pre-sign-in tables, and each of them read-only', async () => {
    const { rows } = await client.query<{ table_name: string; privileges: string }>(`
      SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) privileges
        FROM information_schema.role_table_grants
       WHERE grantee = 'anon' AND table_schema = 'public'
       GROUP BY table_name
       ORDER BY table_name
    `);

    expect(rows.map((row) => row.table_name)).toEqual(PRE_SIGN_IN_TABLES);
    // Read-only: a signed-out caller has never needed to write any of them, and
    // `app_releases` carried INSERT and UPDATE for years on the strength of a
    // default grant nobody asked for.
    for (const row of rows) {
      expect(row.privileges, `${row.table_name} should be SELECT-only for anon`).toBe('SELECT');
    }
  });

  it('pins search_path on every function in public', async () => {
    const { rows } = await client.query<{ proname: string }>(`
      SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND NOT EXISTS (
           SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%'
         )
       ORDER BY 1
    `);

    // A definer function that resolves unqualified names against the caller's
    // search_path is the classic way to get it to read somebody else's table.
    // The triggers are not definer, but they run on every write and have no
    // reason to inherit a path either.
    expect(rows.map((row) => row.proname)).toEqual([]);
  });
});
