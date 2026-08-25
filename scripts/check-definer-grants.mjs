#!/usr/bin/env node
//
// Every SECURITY DEFINER function must declare its caller model.
//
// Supabase grants EXECUTE on new functions to `anon, authenticated,
// service_role` by default, and Postgres itself grants EXECUTE to PUBLIC. So a
// freshly created SECURITY DEFINER function — which runs with the owner's
// rights and bypasses RLS — is reachable by the UNauthenticated `anon` key
// unless the migration says otherwise. A missing membership check inside one
// such function is an RLS bypass (audit 20260825240000).
//
// This guard forces the decision to be written down: any migration that CREATEs
// (or OR REPLACEs) a SECURITY DEFINER function must, IN THE SAME FILE, contain
// an explicit GRANT or REVOKE on that function. That is what makes a signature
// change — which mints a NEW function and silently re-applies the anon/PUBLIC
// default — fail here instead of in production (the exact way baaki_consume_invite
// regained anon after its revoke).
//
// Grandfathered: migrations dated before the cutoff (the audit migration) are
// exempt, so the existing tree passes; everything from the audit onward must
// declare. Simple text scan — comments stripped first so prose about functions
// never counts as a definition or a grant.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'packages/db/prisma/migrations';
// The audit migration and everything after it must declare a caller model.
const CUTOFF = '20260825240000';

/** Remove -- line comments and /* *​/ block comments so only real SQL remains. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * Names of SECURITY DEFINER functions defined in `sql`. A function's body runs
 * from its `CREATE FUNCTION` to the next one (or end of file); if `SECURITY
 * DEFINER` appears in that span, it is a definer function.
 */
function definerFunctions(sql) {
  const create =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?("?[a-zA-Z0-9_]+"?)\s*\(/gi;
  const starts = [];
  let m;
  while ((m = create.exec(sql)) !== null) {
    starts.push({ name: m[1].replace(/"/g, ''), index: m.index });
  }
  const names = new Set();
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : sql.length;
    if (/\bSECURITY\s+DEFINER\b/i.test(sql.slice(from, to))) names.add(starts[i].name);
  }
  return names;
}

/** True if `sql` has a GRANT or REVOKE that names `fn` after ON FUNCTION. */
function hasGrantOrRevoke(sql, fn) {
  // Matches both single-function statements and the multi-function list form
  //   GRANT EXECUTE ON FUNCTION
  //     public.a(...),
  //     public.b(...)
  // by looking for the function name anywhere after an ON FUNCTION token that
  // belongs to a GRANT/REVOKE, up to the terminating semicolon.
  const re = new RegExp(
    String.raw`\b(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+FUNCTION\b[\s\S]*?\b(?:public\.)?${fn}\s*\([\s\S]*?;`,
    'i',
  );
  return re.test(sql);
}

function main() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`check-definer-grants: ${MIGRATIONS_DIR} not found`);
    process.exit(1);
  }
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
    .map((d) => d.name)
    .filter((name) => name.slice(0, 14) >= CUTOFF)
    .sort();

  const failures = [];
  for (const dir of dirs) {
    const file = join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (!existsSync(file)) continue;
    const sql = stripComments(readFileSync(file, 'utf8'));
    for (const fn of definerFunctions(sql)) {
      if (!hasGrantOrRevoke(sql, fn)) {
        failures.push({ dir, fn });
      }
    }
  }

  if (failures.length > 0) {
    console.error('SECURITY DEFINER functions created without an explicit GRANT/REVOKE:');
    for (const { dir, fn } of failures) {
      console.error(`  ${dir}: public.${fn}`);
    }
    console.error('');
    console.error('A SECURITY DEFINER function bypasses RLS and is granted to anon + PUBLIC by');
    console.error('default. In the SAME migration, state its caller model explicitly, e.g.:');
    console.error('  REVOKE EXECUTE ON FUNCTION public.<fn>(<args>) FROM anon, PUBLIC;');
    console.error(
      '  GRANT  EXECUTE ON FUNCTION public.<fn>(<args>) TO authenticated, service_role;',
    );
    console.error('(service_role only for trigger/cron/edge-only functions).');
    process.exit(1);
  }

  console.log(`check-definer-grants: OK (${dirs.length} migration(s) at or after ${CUTOFF})`);
}

main();
