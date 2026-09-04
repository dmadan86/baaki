// @ts-nocheck
/**
 * Demo data seeder — a realistic dashboard to look at, not a test fixture.
 *
 * Fills a *development* database with one focus user who belongs to several
 * groups of mixed shape: some members are real signed-in profiles, some are
 * ghosts (name-only people, ADR-006), a handful of expenses carry real
 * descriptions, a few debts have been settled, and a couple of groups are
 * archived. Point a fresh clone at this and the Home, Activity and Friends
 * screens all have something true to render.
 *
 * Run (from the repo root or packages/db):
 *   pnpm --filter @waves/db seed              # append demo data
 *   pnpm --filter @waves/db seed:purge        # remove it again
 * or directly:
 *   node packages/db/scripts/seed-demo.mjs [--purge]
 *
 * Everything it writes is tagged with `SEED_TAG` (default "Demo:") in the group
 * and profile names, so a purge can find and cascade-delete exactly its own rows
 * and nothing hand-made.
 *
 * A note on guests: a Waves "guest" is an anonymous auth account, and
 * `auth.users.is_anonymous` only exists on Supabase — a bare local Postgres has
 * no auth schema (the profiles table is the source of truth there). So on a
 * local DB the mix of "signed-in and guest" is modelled as profile-backed
 * members (signed-in) vs ghost members (the not-signed-up people). Against a
 * Supabase DB you would additionally create anonymous auth users; that needs the
 * admin API and is deliberately out of scope for this SQL seeder.
 */

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import 'dotenv/config';

const { Client } = pg;

// ── config ───────────────────────────────────────────────────────────────

// NOT DATABASE_URL / DIRECT_URL on purpose — those point at whatever project is
// being deployed to. This writes and deletes freely, so it only ever talks to an
// explicitly-named dev database, and refuses a remote host unless told twice.
const CONNECTION_STRING =
  process.env.SEED_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:54330/waves';

const TAG = process.env.SEED_TAG ?? 'Demo:';
const FOCUS_NAME = `${TAG} You`;

// A tiny seedable PRNG so a run is reproducible when SEED_RANDOM is set, and
// varied otherwise.
let seedState = Number(process.env.SEED_RANDOM ?? Date.now()) >>> 0;
function rand() {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function sample(arr, k) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, k);
}

// ── content pools ──────────────────────────────────────────────────────────

const PEOPLE = ['Aarav', 'Diya', 'Kabir', 'Ananya', 'Vivaan', 'Ishaan', 'Meera', 'Rohan', 'Sara'];
const GHOSTS = ['Priya', 'Sam', 'Nikhil', 'Zoya', 'Dev'];
const DESCRIPTIONS = [
  'Dinner',
  'Groceries',
  'Uber to airport',
  'Coffee',
  'Movie tickets',
  'Hotel night',
  'Lunch',
  'Drinks',
  'Petrol',
  'Snacks',
  'Train tickets',
  'Museum entry',
  'Breakfast',
  'Beach shack',
  'Auto rickshaw',
  'Pizza',
  'Ice cream',
  'Souvenirs',
  'Boat ride',
  'Parking',
  'Water bottles',
  'SIM card',
  'Laundry',
  'Bakery',
  'Street food',
];
const CATEGORIES = ['food', 'travel', 'stay', 'transport', 'misc', null];

/** The groups to build. `members` is how many, `ghosts` of those are ghosts. */
const GROUP_TEMPLATES = [
  { name: 'Goa Trip', type: 'trip', currency: 'INR', emoji: '🏖️', members: 5, ghosts: 1, trip: true },
  { name: 'Flatmates', type: 'home', currency: 'INR', emoji: '🏠', members: 4, ghosts: 0 },
  { name: 'Weekend in Dubai', type: 'trip', currency: 'AED', emoji: '🌆', members: 4, ghosts: 2, trip: true },
  { name: 'Office Party', type: 'event', currency: 'INR', emoji: '🎉', members: 6, ghosts: 1 },
  { name: 'Us', type: 'couple', currency: 'INR', emoji: '❤️', members: 2, ghosts: 0 },
];

const SETTLEMENT_METHODS = ['upi', 'cash', 'bank', 'other'];

// ── helpers ──────────────────────────────────────────────────────────────

/** Equal split in minor units, remainder handed to the first few — Σ = amount. */
function equalShares(amount, memberIds) {
  const n = BigInt(memberIds.length);
  const base = amount / n;
  let remainder = amount - base * n; // 0 <= remainder < n
  return memberIds.map((id) => {
    let owed = base;
    if (remainder > 0n) {
      owed += 1n;
      remainder -= 1n;
    }
    return [id, owed];
  });
}

/** A date `daysAgo` back, as YYYY-MM-DD. */
function dateDaysAgo(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function insertProfile(client, name, currency = 'INR') {
  const id = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, $2, $3)`,
    [id, `${TAG} ${name}`, currency],
  );
  return id;
}

async function insertExpense(client, { groupId, payerMemberId, memberIds, amount, currency, description, category, date }) {
  const expenseId = randomUUID();
  const versionId = randomUUID();
  await client.query(`INSERT INTO expenses (id, group_id, created_by) VALUES ($1, $2, $3)`, [
    expenseId,
    groupId,
    payerMemberId,
  ]);
  await client.query(
    `INSERT INTO expense_versions
       (id, expense_id, version_no, author_member_id, description, category, expense_date,
        currency, amount, split_type, split_params, source)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, 'equal', '{"kind":"equal"}'::jsonb, 'manual')`,
    [versionId, expenseId, payerMemberId, description, category, date, currency, amount.toString()],
  );
  await client.query(
    `INSERT INTO expense_payers (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), versionId, payerMemberId, amount.toString()],
  );
  for (const [memberId, owed] of equalShares(amount, memberIds)) {
    await client.query(
      `INSERT INTO expense_shares (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), versionId, memberId, owed.toString()],
    );
  }
  await client.query(`UPDATE expenses SET current_version_id = $1 WHERE id = $2`, [
    versionId,
    expenseId,
  ]);
  return expenseId;
}

// ── purge ────────────────────────────────────────────────────────────────

async function purge(client) {
  // Groups cascade to members, expenses, versions, payers, shares, settlements
  // and balances. Then the seeded profiles, which members reference with
  // ON DELETE SET NULL, so they are safe to drop afterwards.
  const groups = await client.query(`DELETE FROM groups WHERE name LIKE $1 RETURNING id`, [
    `${TAG}%`,
  ]);
  const profiles = await client.query(`DELETE FROM profiles WHERE display_name LIKE $1 RETURNING id`, [
    `${TAG}%`,
  ]);
  console.log(`Purged ${groups.rowCount} group(s) and ${profiles.rowCount} profile(s) tagged "${TAG}".`);
}

// ── seed ─────────────────────────────────────────────────────────────────

async function seed(client) {
  // The person whose dashboard this is — a signed-in profile.
  const focusId = await insertProfile(client, 'You');

  // A pool of other signed-in people to draw group members from.
  const others = [];
  for (const name of PEOPLE) others.push({ name, profileId: await insertProfile(client, name) });

  const summary = [];
  let totalExpenses = 0;
  let totalSettlements = 0;
  let totalDeleted = 0;
  let totalArchived = 0;

  // Aim for the whole seed to land in the 20–100 expense band the brief asked
  // for, spread across the groups.
  const targetExpenses = randInt(20, 100);
  const perGroup = Math.max(3, Math.round(targetExpenses / GROUP_TEMPLATES.length));

  for (const [index, tpl] of GROUP_TEMPLATES.entries()) {
    const groupId = randomUUID();
    const archived = index >= GROUP_TEMPLATES.length - 2 ? rand() < 0.6 : false;

    await client.query(
      `INSERT INTO groups (id, name, type, default_currency, cover_emoji, created_by, archived_at, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        groupId,
        `${TAG} ${tpl.name}`,
        tpl.type,
        tpl.currency,
        tpl.emoji,
        focusId,
        archived ? new Date().toISOString() : null,
        tpl.trip ? dateDaysAgo(randInt(20, 40)) : null,
        tpl.trip ? dateDaysAgo(randInt(1, 10)) : null,
      ],
    );
    if (archived) totalArchived += 1;

    // The focus user is always in, as admin. Then a mix of signed-in profiles
    // and ghosts (the "guests" — people who have not signed up).
    const memberIds = [];
    const focusMemberId = randomUUID();
    await client.query(
      `INSERT INTO group_members (id, group_id, profile_id, role, joined_via)
       VALUES ($1, $2, $3, 'admin', 'creator')`,
      [focusMemberId, groupId, focusId],
    );
    memberIds.push(focusMemberId);

    const signedInCount = Math.max(1, tpl.members - tpl.ghosts - 1);
    for (const person of sample(others, signedInCount)) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO group_members (id, group_id, profile_id, role, joined_via)
         VALUES ($1, $2, $3, 'member', 'invite_link')`,
        [id, groupId, person.profileId],
      );
      memberIds.push(id);
    }
    for (const ghostName of sample(GHOSTS, tpl.ghosts)) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO group_members (id, group_id, ghost_name, joined_via)
         VALUES ($1, $2, $3, 'ghost')`,
        [id, groupId, ghostName],
      );
      memberIds.push(id);
    }

    // Expenses — real descriptions, varied amounts, one random payer, split
    // equally across a random subset of the group (at least two).
    const count = perGroup + randInt(-2, 3);
    const expenseIds = [];
    for (let i = 0; i < count; i += 1) {
      const participants = sample(memberIds, Math.max(2, randInt(2, memberIds.length)));
      const payer = pick(participants);
      const amount = BigInt(randInt(5, 500)) * 100n; // ₹5–₹500 in paise
      const id = await insertExpense(client, {
        groupId,
        payerMemberId: payer,
        memberIds: participants,
        amount,
        currency: tpl.currency,
        description: pick(DESCRIPTIONS),
        category: pick(CATEGORIES),
        date: dateDaysAgo(randInt(0, 45)),
      });
      expenseIds.push(id);
      totalExpenses += 1;
    }

    // A few of them get removed — the soft-delete the app does, so the feed and
    // balances both know they are gone.
    for (const id of sample(expenseIds, Math.min(2, Math.floor(expenseIds.length / 8)))) {
      await client.query(`UPDATE expenses SET deleted_at = now(), deleted_by = $1 WHERE id = $2`, [
        focusMemberId,
        id,
      ]);
      totalDeleted += 1;
    }

    // A settlement or two — someone paid someone back. A mix of confirmed and
    // still-initiated, so the "pending confirmation" state has something too.
    if (memberIds.length >= 2) {
      const settlementCount = randInt(1, 2);
      for (let i = 0; i < settlementCount; i += 1) {
        const [from, to] = sample(memberIds, 2);
        const confirmed = rand() < 0.6;
        await client.query(
          `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method, status, confirmed_at, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            groupId,
            from,
            to,
            tpl.currency,
            (BigInt(randInt(2, 200)) * 100n).toString(),
            pick(SETTLEMENT_METHODS),
            confirmed ? 'confirmed' : 'initiated',
            confirmed ? new Date().toISOString() : null,
            'Paid back',
          ],
        );
        totalSettlements += 1;
      }
    }

    summary.push(
      `  • ${tpl.name} (${tpl.type}, ${tpl.currency})${archived ? ' [archived]' : ''} — ${memberIds.length} members, ${count} expenses`,
    );
  }

  console.log('\nSeeded demo data:');
  console.log(`  Focus user: ${FOCUS_NAME}  (${focusId})`);
  console.log(summary.join('\n'));
  console.log(
    `\n  ${GROUP_TEMPLATES.length} groups · ${totalExpenses} expenses · ${totalSettlements} settlements · ${totalDeleted} deleted · ${totalArchived} archived`,
  );
  console.log(`\n  Focus user profile id (open its dashboard as this user):\n    ${focusId}\n`);
}

// ── entry ────────────────────────────────────────────────────────────────

async function main() {
  const host = new URL(CONNECTION_STRING.replace(/^postgres(ql)?:/, 'http:')).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal && process.env.SEED_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to seed a non-local host (${host}). This writes and deletes demo rows. ` +
        `Set SEED_ALLOW_REMOTE=1 to override, and be sure it is not production.`,
    );
  }

  const client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (process.env.SEED_PURGE === '1' || process.argv.includes('--purge')) {
      await purge(client);
    } else {
      await seed(client);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const detail = error?.code ? `${error.code}: ${error.message}` : (error?.stack ?? error?.message ?? error);
  console.error(`Seed failed — ${detail}`);
  if (error?.code === 'ECONNREFUSED') {
    console.error(
      `  No database at ${CONNECTION_STRING}. Start the local Postgres (or set SEED_DATABASE_URL) and retry.`,
    );
  }
  process.exit(1);
});
