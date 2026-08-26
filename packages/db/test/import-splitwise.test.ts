/**
 * The Splitwise importer, proved end to end against a real Postgres.
 *
 * A Splitwise export carries only each person's NET per row, yet the acceptance
 * bar for bringing a group across (TDR §10) is that the *balances* round-trip
 * exactly. This test takes a real 90-plus-row export — a two-week Vietnam trip
 * with five people, three of them member-to-member repayments — parses it,
 * imports it through `baaki_import_ledger`, and checks that:
 *
 *   - the five people become one real member (the importing account) and four
 *     ghosts;
 *   - the Payment rows land as settlements, not expenses;
 *   - every derived balance equals that person's net summed straight from the
 *     CSV — and equals Splitwise's own "Total balance" row to the paisa;
 *   - the balances sum to zero (ADR-004/014);
 *   - nothing in the file failed to reconcile.
 *
 * Runs against the local Postgres test DB (see `helpers.CONNECTION_STRING`),
 * cleaning up the rows it seeds afterwards.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import {
  formatImportReport,
  importSplitwiseLedger,
  parseSplitwiseCsv,
  type ImportResult,
  type SplitwiseParse,
} from '../src/import/splitwise.js';
import { SPLITWISE_EXPORT_CSV } from './fixtures/splitwiseExport.js';
import { big, connect } from './helpers.js';

/** The account the import lands in — its Splitwise column is "Madan D". */
const USER_NAME = 'Madan D';

/**
 * Splitwise's own "Total balance" row from the bottom of the export, in minor
 * units. The importer never reads this row (it is not an expense); it is the
 * independent oracle every derived balance must match.
 */
const EXPECTED_NET: Readonly<Record<string, bigint>> = {
  'Madan D': 2_418_242n,
  Hethu: -41_148n,
  'Lokesh Rangasamy': -1_517_166n,
  Renny: -499_679n,
  Gayathri: -360_249n,
};

let client: Client;
let userId: string;
let parse: SplitwiseParse;
let dryRun: ImportResult;
let imported: ImportResult;

beforeAll(async () => {
  client = await connect();

  userId = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, $2, 'INR')`,
    [userId, USER_NAME],
  );

  parse = parseSplitwiseCsv(SPLITWISE_EXPORT_CSV);

  // A dry run first: it must return the plan and write nothing.
  dryRun = await importSplitwiseLedger(client, {
    parse,
    userId,
    userName: USER_NAME,
    dryRun: true,
  });

  // Print the report so a `pnpm test:db` run doubles as the human-eyeball
  // artefact before the real production import.
  // eslint-disable-next-line no-console
  console.log('\n' + formatImportReport(dryRun) + '\n');

  imported = await importSplitwiseLedger(client, {
    parse,
    userId,
    userName: USER_NAME,
    dryRun: false,
  });
}, 60_000);

afterAll(async () => {
  // Leave the shared test DB as it was found. A plain DELETE cascades into the
  // append-only ledger, which the trigger (ADR-004) refuses — so teardown runs
  // with triggers off, exactly as the twenty-user scenario does.
  try {
    if (imported?.groupId) {
      await client.query(`SET session_replication_role = replica`);
      await client.query(`DELETE FROM groups WHERE id = $1`, [imported.groupId]);
      await client.query(`DELETE FROM profiles WHERE id = $1`, [userId]);
      await client.query(`SET session_replication_role = origin`);
    }
  } finally {
    await client?.end();
  }
});

describe('splitwise import: parsing', () => {
  it('reconciles every row — no errors', () => {
    expect(parse.errors).toEqual([]);
  });

  it('finds the five people, in column order', () => {
    expect(parse.people).toEqual(['Madan D', 'Hethu', 'Lokesh Rangasamy', 'Renny', 'Gayathri']);
  });

  it('separates the three member-to-member payments from the expenses', () => {
    expect(parse.settlements).toHaveLength(3);
    expect(parse.expenses.length).toBeGreaterThan(0);
    // Every payment is one person paying one other; positive-net person paid.
    for (const settlement of parse.settlements) {
      expect(settlement.from).not.toBe(settlement.to);
      expect(settlement.amount).toBeGreaterThan(0n);
    }
  });

  it('reconstructs payers and shares that each sum to the cost', () => {
    for (const expense of parse.expenses) {
      const paid = Object.values(expense.payers).reduce((a, b) => a + b, 0n);
      const owed = Object.values(expense.shares).reduce((a, b) => a + b, 0n);
      expect(paid).toBe(expense.amount);
      expect(owed).toBe(expense.amount);
    }
  });

  it("matches Splitwise's own Total balance row to the paisa", () => {
    expect(parse.netByPerson).toEqual(EXPECTED_NET);
    const total = Object.values(parse.netByPerson).reduce((a, b) => a + b, 0n);
    expect(total).toBe(0n);
  });
});

describe('splitwise import: the dry run writes nothing', () => {
  it('returns a plan but no group', () => {
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.groupId).toBeUndefined();
    expect(dryRun.plan.expenseCount).toBe(parse.expenses.length);
    expect(dryRun.plan.settlementCount).toBe(3);
    expect(dryRun.plan.members).toHaveLength(5);
  });
});

describe('splitwise import: the real write', () => {
  it('creates one real member and four ghosts', async () => {
    const rows = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE profile_id IS NOT NULL)::int AS real,
              count(*) FILTER (WHERE ghost_name IS NOT NULL)::int AS ghosts
         FROM group_members WHERE group_id = $1 AND left_at IS NULL`,
      [imported.groupId],
    );
    expect(rows.rows[0]).toMatchObject({ total: 5, real: 1, ghosts: 4 });
  });

  it('writes every expense and every settlement', async () => {
    const expenses = await client.query(
      `SELECT count(*) AS n FROM expenses WHERE group_id = $1 AND deleted_at IS NULL`,
      [imported.groupId],
    );
    expect(big(expenses.rows[0]?.n)).toBe(BigInt(parse.expenses.length));

    const settlements = await client.query(
      `SELECT count(*) AS n FROM settlements WHERE group_id = $1`,
      [imported.groupId],
    );
    expect(big(settlements.rows[0]?.n)).toBe(3n);
  });

  it('imported expenses are marked as imported, never manual', async () => {
    const rows = await client.query(
      `SELECT count(*) FILTER (WHERE v.source <> 'imported') AS not_imported
         FROM expense_versions v
         JOIN expenses e ON e.current_version_id = v.id
        WHERE e.group_id = $1`,
      [imported.groupId],
    );
    expect(big(rows.rows[0]?.not_imported)).toBe(0n);
  });

  it('derives a balance for each person equal to their CSV net, summing to zero', async () => {
    const truth = await client.query(
      `SELECT member_id, balance FROM baaki_group_balances_truth($1)`,
      [imported.groupId],
    );
    const balanceByMember = new Map<string, bigint>(
      truth.rows.map((row) => [String(row.member_id), big(row.balance)]),
    );

    const nameById = new Map<string, string>(
      Object.entries(imported.memberIdByName ?? {}).map(([name, id]) => [id, name]),
    );

    const derivedByName: Record<string, bigint> = {};
    let total = 0n;
    for (const [memberId, balance] of balanceByMember) {
      const name = nameById.get(memberId);
      expect(name).toBeDefined();
      derivedByName[name as string] = balance;
      total += balance;
    }

    expect(derivedByName).toEqual(EXPECTED_NET);
    expect(total).toBe(0n);
  });
});
