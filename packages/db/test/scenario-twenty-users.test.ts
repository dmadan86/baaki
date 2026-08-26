/**
 * A real-scale scenario, end to end: twenty actual users (profile-backed, not
 * ghosts), three groups they all belong to, and a heavy, varied ledger —
 * ~100 expenses in one group, ~30 in another, ~20 with uneven shares in a
 * third, some members deliberately left out of a split because they did not
 * chip in.
 *
 * The point is not any one number but that the whole thing stays coherent at
 * size: the derived balances still equal the ground-truth aggregate and still
 * sum to zero in every group (ADR-004 / ADR-014), every expense's shares and
 * payers reconcile to its total (ADR-003), and a member excluded from a split
 * carries no share for it. If the app's core promise ("your baaki is always
 * right") survives 150 mixed expenses across twenty people, it survives a trip.
 *
 * Runs against the local Postgres test DB (see `helpers.CONNECTION_STRING`),
 * cleaning up the rows it seeds afterwards.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import {
  addEqualSplitExpense,
  addSplitExpense,
  big,
  connect,
  readBalances,
  readTruth,
} from './helpers.js';

// ── determinism ────────────────────────────────────────────────────────────
// A tiny seeded PRNG so the scenario is the same on every run — a flaky ledger
// test is worse than none, and a fixed seed makes a failure reproducible.
let seedState = 0x9e3779b9;
function rand(): number {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
function sample<T>(arr: readonly T[], k: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, k);
}

const USER_COUNT = 20;
const DESCRIPTIONS = [
  'Dinner',
  'Groceries',
  'Cab',
  'Coffee',
  'Movie',
  'Hotel',
  'Lunch',
  'Drinks',
  'Petrol',
  'Snacks',
  'Train',
  'Museum',
  'Breakfast',
  'Beach shack',
  'Auto',
  'Pizza',
  'Ice cream',
  'Souvenirs',
  'Boat ride',
  'Parking',
];

let client: Client;
/** The twenty real users, as profile ids. Shared across all three groups. */
let profileIds: string[] = [];
const groupIds: string[] = [];

/** memberId → member row per group, so a group's ledger can be built and read. */
interface Group {
  id: string;
  /** group_member ids, index-aligned with `profileIds`. */
  memberIds: string[];
}

async function seedProfiles(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= USER_COUNT; i += 1) {
    const id = randomUUID();
    // A real, signed-up identity — a profile row, the local source of truth for
    // a user (auth.users lives only on Supabase). Named like an account, never a
    // ghost: every member below references one of these.
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, $2, 'INR')`,
      [id, `User ${i}`],
    );
    ids.push(id);
  }
  return ids;
}

/** A group with all twenty users as full (profile-backed) members. */
async function seedGroupOfTwenty(name: string): Promise<Group> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO groups (id, name, type, default_currency, created_by)
     VALUES ($1, $2, 'trip', 'INR', $3)`,
    [id, name, profileIds[0] ?? null],
  );
  const memberIds: string[] = [];
  for (const [index, profileId] of profileIds.entries()) {
    const memberId = randomUUID();
    await client.query(
      `INSERT INTO group_members (id, group_id, profile_id, role, joined_via)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        memberId,
        id,
        profileId,
        index === 0 ? 'admin' : 'member',
        index === 0 ? 'creator' : 'invite_link',
      ],
    );
    memberIds.push(memberId);
  }
  groupIds.push(id);
  return { id, memberIds };
}

let groupOne: Group;
let groupTwo: Group;
let groupThree: Group;
/** Per group3 expense: the members left out of the split (did not contribute). */
const group3Excluded = new Map<string, Set<string>>();

beforeAll(async () => {
  client = await connect();
  profileIds = await seedProfiles();

  // ── Group 1: ~100 expenses, from tiny to large, split across the whole
  //    group or a random subset, a single random payer each. ────────────────
  groupOne = await seedGroupOfTwenty('Scenario One');
  for (let i = 0; i < 100; i += 1) {
    // Guarantee the range spans small→big: the first is 50 paise, the second
    // is ₹50,000, the rest are spread in between with jitter.
    const amount = i === 0 ? 50n : i === 1 ? 5_000_000n : BigInt(randInt(1, 50_000)) * 100n;
    // Most expenses are the whole group; a fifth are a random subset (≥2).
    const participants =
      rand() < 0.2 ? sample(groupOne.memberIds, randInt(2, USER_COUNT)) : groupOne.memberIds;
    const payer = pick(participants);
    await addEqualSplitExpense(client, {
      groupId: groupOne.id,
      amount,
      payers: { [payer]: amount },
      participants,
      description: pick(DESCRIPTIONS),
      date: '2026-03-01',
    });
  }

  // ── Group 2: ~30 expenses, each shared by a varying-size subset (12–20). ──
  groupTwo = await seedGroupOfTwenty('Scenario Two');
  for (let i = 0; i < 30; i += 1) {
    const participants = sample(groupTwo.memberIds, randInt(12, USER_COUNT));
    const amount = BigInt(randInt(200, 20_000)) * 100n;
    const payer = pick(participants);
    await addEqualSplitExpense(client, {
      groupId: groupTwo.id,
      amount,
      payers: { [payer]: amount },
      participants,
      description: pick(DESCRIPTIONS),
      date: '2026-03-02',
    });
  }

  // ── Group 3: ~20 expenses with uneven shares, and a few members left out of
  //    each split (they did not contribute). Alternating shares/exact kinds. ─
  groupThree = await seedGroupOfTwenty('Scenario Three');
  for (let i = 0; i < 20; i += 1) {
    // Drop a handful of members from this expense — the non-contributors.
    const participants = sample(groupThree.memberIds, randInt(5, 15));
    const excluded = new Set(groupThree.memberIds.filter((m) => !participants.includes(m)));
    const amount = BigInt(randInt(300, 15_000)) * 100n;
    const payer = pick(participants);

    // Uneven shares: random integer weights per contributor.
    const weights: Record<string, number> = {};
    for (const m of participants) weights[m] = randInt(1, 5);

    const { expenseId } = await addSplitExpense(client, {
      groupId: groupThree.id,
      amount,
      payers: { [payer]: amount },
      participants,
      params:
        i % 2 === 0
          ? { kind: 'shares', weights }
          : // Exact: derive valid amounts from the same weights so they sum to
            // the total, then feed them as an exact split (exercises that path).
            {
              kind: 'exact',
              amounts: sharesToAmounts(amount, participants, weights),
            },
      description: pick(DESCRIPTIONS),
      date: '2026-03-03',
    });
    group3Excluded.set(expenseId, excluded);
  }
}, 120_000);

afterAll(async () => {
  // Leave the shared test DB as it was found. A plain DELETE cascades into the
  // expenses, which the append-only trigger (ADR-004) refuses — so teardown
  // runs with triggers off (the test connects as the DB superuser), the one
  // place hard-deleting the ledger is legitimate.
  try {
    await client.query(`SET session_replication_role = replica`);
    for (const id of groupIds) await client.query(`DELETE FROM groups WHERE id = $1`, [id]);
    for (const id of profileIds) await client.query(`DELETE FROM profiles WHERE id = $1`, [id]);
    await client.query(`SET session_replication_role = origin`);
  } finally {
    await client?.end();
  }
});

/** Largest-remainder apportionment of `amount` over weighted participants — a
 *  valid exact split (every share ≥ 0, all shares sum to the total). */
function sharesToAmounts(
  amount: bigint,
  participants: string[],
  weights: Record<string, number>,
): Record<string, bigint> {
  const totalWeight = participants.reduce((s, m) => s + weights[m]!, 0);
  const out: Record<string, bigint> = {};
  let allocated = 0n;
  const remainders: { id: string; frac: number }[] = [];
  for (const m of participants) {
    const exact = (Number(amount) * weights[m]!) / totalWeight;
    const floorShare = BigInt(Math.floor(exact));
    out[m] = floorShare;
    allocated += floorShare;
    remainders.push({ id: m, frac: exact - Math.floor(exact) });
  }
  // Hand the leftover minor units to the largest fractional remainders.
  let leftover = amount - allocated;
  remainders.sort((a, b) => b.frac - a.frac);
  for (const { id } of remainders) {
    if (leftover <= 0n) break;
    out[id] = (out[id] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return out;
}

// ── assertions ───────────────────────────────────────────────────────────

describe('twenty-user scenario: membership', () => {
  it('gives every group twenty real, profile-backed members and no ghosts', async () => {
    for (const group of [groupOne, groupTwo, groupThree]) {
      const rows = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE profile_id IS NOT NULL)::int AS real,
                count(*) FILTER (WHERE ghost_name IS NOT NULL)::int AS ghosts
           FROM group_members WHERE group_id = $1 AND left_at IS NULL`,
        [group.id],
      );
      expect(rows.rows[0]).toMatchObject({ total: USER_COUNT, real: USER_COUNT, ghosts: 0 });
    }
  });
});

describe('twenty-user scenario: expense volume', () => {
  it('records ~100 / ~30 / ~20 live expenses across the three groups', async () => {
    // Sequential, not Promise.all: a single pg client cannot run overlapping
    // queries (it warns and serialises anyway).
    const counts: bigint[] = [];
    for (const group of [groupOne, groupTwo, groupThree]) {
      const row = await client.query(
        `SELECT count(*) AS n FROM expenses WHERE group_id = $1 AND deleted_at IS NULL`,
        [group.id],
      );
      counts.push(big(row.rows[0]?.n));
    }
    expect(counts).toEqual([100n, 30n, 20n]);
  });

  it('spans small to large amounts in group one', async () => {
    const row = (
      await client.query(
        `SELECT min(v.amount) AS lo, max(v.amount) AS hi
           FROM expense_versions v
           JOIN expenses e ON e.current_version_id = v.id
          WHERE e.group_id = $1 AND e.deleted_at IS NULL`,
        [groupOne.id],
      )
    ).rows[0];
    expect(big(row.lo)).toBeLessThanOrEqual(100n); // a genuinely small spend
    expect(big(row.hi)).toBeGreaterThanOrEqual(1_000_000n); // a genuinely big one
  });
});

describe('twenty-user scenario: the ledger stays right at scale', () => {
  it('derived balances equal ground truth and sum to zero in every group', async () => {
    for (const group of [groupOne, groupTwo, groupThree]) {
      const stored = await readBalances(client, group.id);
      const truth = await readTruth(client, group.id);
      expect([...stored.entries()].sort()).toEqual([...truth.entries()].sort());

      let total = 0n;
      for (const balance of stored.values()) total += balance;
      expect(total).toBe(0n);
    }
  });

  it('reconciles every expense: shares and payers each sum to the total', async () => {
    for (const group of [groupOne, groupTwo, groupThree]) {
      const bad = await client.query(
        `SELECT v.id
           FROM expense_versions v
           JOIN expenses e ON e.current_version_id = v.id
           LEFT JOIN (SELECT expense_version_id, sum(amount) s FROM expense_shares GROUP BY 1) sh
                  ON sh.expense_version_id = v.id
           LEFT JOIN (SELECT expense_version_id, sum(amount) p FROM expense_payers GROUP BY 1) pa
                  ON pa.expense_version_id = v.id
          WHERE e.group_id = $1 AND e.deleted_at IS NULL
            AND (sh.s IS DISTINCT FROM v.amount OR pa.p IS DISTINCT FROM v.amount)`,
        [group.id],
      );
      expect(bad.rowCount).toBe(0);
    }
  });
});

describe('twenty-user scenario: non-contributors carry no share', () => {
  it('leaves excluded members out of the split they did not join', async () => {
    for (const [expenseId, excluded] of group3Excluded) {
      const versionRow = (
        await client.query(`SELECT current_version_id FROM expenses WHERE id = $1`, [expenseId])
      ).rows[0];
      const versionId = String(versionRow.current_version_id);

      const shareRows = await client.query(
        `SELECT member_id FROM expense_shares WHERE expense_version_id = $1`,
        [versionId],
      );
      const shareMembers = new Set(shareRows.rows.map((r) => String(r.member_id)));

      // Nobody excluded has a share…
      for (const member of excluded) expect(shareMembers.has(member)).toBe(false);
      // …and every share belongs to a contributor (never an excluded member).
      for (const member of shareMembers) expect(excluded.has(member)).toBe(false);
      expect(shareMembers.size).toBeGreaterThan(0);
    }
  });
});
