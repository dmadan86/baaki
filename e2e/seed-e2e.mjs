// @ts-nocheck
/**
 * Deterministic E2E fixture — the exact, known state the Maestro flows assert.
 *
 * Unlike `seed-demo` (a randomised dashboard to look at), this writes ONE fixed
 * account and ONE fixed group so `e2e/*.yaml` can assert real strings — "Goa
 * trip", "Beach shack dinner", the ghost "Priya" — instead of degrading to
 * `optional` "screen renders" proofs. It is the other half of un-disabling the
 * Maestro job in CI: the app signs into this account, syncs, and finds this
 * state.
 *
 * It talks to a Supabase project over the service key (bypassing RLS) plus the
 * admin API (to mint the login user). It NEVER touches the local Postgres or a
 * production project — it refuses to run against the known prod ref and requires
 * an explicit `E2E_SUPABASE_URL`.
 *
 * Required env:
 *   E2E_SUPABASE_URL   staging project URL      (e.g. https://abc.supabase.co)
 *   E2E_SERVICE_KEY    that project's service_role key
 *   E2E_EMAIL          the login the flows use   (e.g. e2e@waves.test)
 *   E2E_PASSWORD       its password
 *
 * Run:  node e2e/seed-e2e.mjs
 *
 * It is idempotent: it deletes any prior fixture (the group, then the user) and
 * rebuilds it, so a re-run always lands the same known state.
 */

import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

// ── config ──────────────────────────────────────────────────────────────────

const URL = process.env.E2E_SUPABASE_URL;
const SERVICE_KEY = process.env.E2E_SERVICE_KEY;
const EMAIL = process.env.E2E_EMAIL ?? 'e2e@waves.test';
const PASSWORD = process.env.E2E_PASSWORD;

// The production project ref. This seeder deletes and rewrites freely, so it
// must never point at it, the way `seed-demo` refuses DATABASE_URL/DIRECT_URL.
const PROD_REF = 'xvjzbpgcmotoahtqcxve';

if (!URL || !SERVICE_KEY || !PASSWORD) {
  console.error(
    'Missing env. Set E2E_SUPABASE_URL, E2E_SERVICE_KEY and E2E_PASSWORD (E2E_EMAIL optional).',
  );
  process.exit(1);
}
if (URL.includes(PROD_REF)) {
  console.error(
    `Refusing to seed the production project (${PROD_REF}). Point at a staging project.`,
  );
  process.exit(1);
}

const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

// The fixture. These strings are the contract the Maestro flows assert.
const GROUP_NAME = 'Goa trip';
const EXPENSE_DESC = 'Beach shack dinner';
const AMOUNT_MINOR = 120000n; // ₹1200.00 in paise
const GHOSTS = ['Priya', 'Sam', 'Dev'];

const die = (msg, error) => {
  console.error(msg, error?.message ?? error ?? '');
  process.exit(1);
};

// Split `total` minor units equally across `n` members, giving the earliest
// members the extra paise so the shares sum to the total exactly.
function equalShares(total, n) {
  const base = total / BigInt(n);
  let remainder = total - base * BigInt(n);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    let share = base;
    if (remainder > 0n) {
      share += 1n;
      remainder -= 1n;
    }
    out.push(share);
  }
  return out;
}

// ── 1. reset any prior fixture ────────────────────────────────────────────────

async function findUserByEmail(email) {
  // The admin API has no get-by-email, so page through until we find it. A
  // staging project stays small, so one or two pages is plenty.
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) die('listUsers failed', error);
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function reset() {
  const existing = await findUserByEmail(EMAIL);
  if (existing) {
    // Delete any groups this user created first (cascades to members, expenses,
    // versions, payers, shares, settlements), then the user (cascades profile).
    const { data: groups } = await db.from('groups').select('id').eq('created_by', existing.id);
    for (const g of groups ?? []) {
      const { error } = await db.from('groups').delete().eq('id', g.id);
      if (error) die(`deleting group ${g.id} failed`, error);
    }
    const { error } = await db.auth.admin.deleteUser(existing.id);
    if (error) die('deleteUser failed', error);
    console.log(`· reset: removed prior fixture user ${EMAIL}`);
  }
}

// ── 2. build the fixture ──────────────────────────────────────────────────────

async function insert(table, row) {
  const { error } = await db.from(table).insert(row);
  if (error) die(`insert into ${table} failed`, error);
}

async function seed() {
  // The login user + its profile.
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (userErr) die('createUser failed', userErr);
  const userId = created.user.id;
  await insert('profiles', { id: userId, display_name: 'You', default_currency: 'INR' });

  // The group.
  const groupId = randomUUID();
  await insert('groups', {
    id: groupId,
    name: GROUP_NAME,
    type: 'trip',
    default_currency: 'INR',
    cover_emoji: '🏖️',
    created_by: userId,
  });

  // Members: the focus user (admin) plus the ghosts the flows name.
  const focusMemberId = randomUUID();
  await insert('group_members', {
    id: focusMemberId,
    group_id: groupId,
    profile_id: userId,
    role: 'admin',
    joined_via: 'creator',
  });
  const ghostIds = {};
  for (const name of GHOSTS) {
    const id = randomUUID();
    ghostIds[name] = id;
    await insert('group_members', {
      id,
      group_id: groupId,
      ghost_name: name,
      joined_via: 'ghost',
    });
  }

  // One expense: paid by Priya, split equally across the three ghosts and NOT
  // the focus user — so the focus user's net balance is zero and `leave-group`
  // can leave without settling first, while `home-to-add-expense` still sees
  // the expense and the ghost.
  const participants = GHOSTS.map((n) => ghostIds[n]);
  const shares = equalShares(AMOUNT_MINOR, participants.length);
  const expenseId = randomUUID();
  const versionId = randomUUID();
  await insert('expenses', { id: expenseId, group_id: groupId, created_by: ghostIds.Priya });
  await insert('expense_versions', {
    id: versionId,
    expense_id: expenseId,
    version_no: 1,
    author_member_id: ghostIds.Priya,
    description: EXPENSE_DESC,
    category: 'food',
    expense_date: '2026-08-01',
    currency: 'INR',
    amount: AMOUNT_MINOR.toString(),
    split_type: 'equal',
    split_params: { kind: 'equal' },
    source: 'manual',
  });
  await insert('expense_payers', {
    id: randomUUID(),
    expense_version_id: versionId,
    member_id: ghostIds.Priya,
    amount: AMOUNT_MINOR.toString(),
  });
  for (let i = 0; i < participants.length; i += 1) {
    await insert('expense_shares', {
      id: randomUUID(),
      expense_version_id: versionId,
      member_id: participants[i],
      amount: shares[i].toString(),
    });
  }
  const { error: curErr } = await db
    .from('expenses')
    .update({ current_version_id: versionId })
    .eq('id', expenseId);
  if (curErr) die('setting current_version_id failed', curErr);

  console.log(
    `✓ seeded ${EMAIL}: "${GROUP_NAME}" with ${GHOSTS.length} ghosts and "${EXPENSE_DESC}" (₹1200)`,
  );
}

// ── run ───────────────────────────────────────────────────────────────────────

await reset();
await seed();
