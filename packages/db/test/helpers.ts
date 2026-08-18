import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import 'dotenv/config';

import { computeShares } from '@waves/core';

/**
 * Deliberately NOT DATABASE_URL / DIRECT_URL: those point at whichever project
 * the developer is currently deploying to, and this suite creates, mutates and
 * deletes rows freely. It only ever talks to an explicitly-named test database.
 */
export const CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54330/baaki';

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  return client;
}

/** pg returns BIGINT as a string to avoid precision loss — keep it exact. */
export function big(value: unknown): bigint {
  return BigInt(String(value));
}

export interface SeededGroup {
  groupId: string;
  profileIds: string[];
  memberIds: string[];
}

export async function seedGroup(
  client: Client,
  options: { memberCount?: number; ghostCount?: number; name?: string } = {},
): Promise<SeededGroup> {
  const { memberCount = 3, ghostCount = 0, name = 'Goa trip' } = options;

  const profileIds: string[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, $2, 'INR')`,
      [id, `Member ${index + 1}`],
    );
    profileIds.push(id);
  }

  const groupId = randomUUID();
  await client.query(
    `INSERT INTO groups (id, name, type, default_currency, created_by)
     VALUES ($1, $2, 'trip', 'INR', $3)`,
    [groupId, name, profileIds[0] ?? null],
  );

  const memberIds: string[] = [];
  for (const [index, profileId] of profileIds.entries()) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO group_members (id, group_id, profile_id, role, joined_via)
       VALUES ($1, $2, $3, $4, 'creator')`,
      [id, groupId, profileId, index === 0 ? 'admin' : 'member'],
    );
    memberIds.push(id);
  }
  for (let index = 0; index < ghostCount; index += 1) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO group_members (id, group_id, ghost_name, joined_via)
       VALUES ($1, $2, $3, 'ghost')`,
      [id, groupId, `Ghost ${index + 1}`],
    );
    memberIds.push(id);
  }

  return { groupId, profileIds, memberIds };
}

export interface AddExpenseOptions {
  groupId: string;
  /** memberId → amount paid. Must sum to `amount`. */
  payers: Record<string, bigint>;
  participants: string[];
  amount: bigint;
  currency?: string;
  description?: string;
  date?: string;
  category?: string | null;
  /**
   * The scanned bill this expense came out of. Set here rather than afterwards
   * because `expense_versions` is append-only (ADR-004) — an UPDATE is refused
   * by the trigger.
   */
  receiptId?: string | null;
}

/**
 * Writes an expense the way the server will: shares are computed by
 * @waves/core, never taken from the caller.
 */
export async function addEqualSplitExpense(
  client: Client,
  options: AddExpenseOptions,
): Promise<{ expenseId: string; versionId: string; shares: Map<string, bigint> }> {
  const {
    groupId,
    payers,
    participants,
    amount,
    currency = 'INR',
    description = 'Dinner',
    date = '2026-03-01',
    category = null,
    receiptId = null,
  } = options;

  const expenseId = randomUUID();
  const versionId = randomUUID();
  const shares = computeShares({
    amount,
    currency,
    params: { kind: 'equal' },
    participants,
    seed: expenseId,
  });

  await client.query('BEGIN');
  await client.query(`INSERT INTO expenses (id, group_id, created_by) VALUES ($1, $2, $3)`, [
    expenseId,
    groupId,
    participants[0] ?? null,
  ]);
  await client.query(
    `INSERT INTO expense_versions
       (id, expense_id, version_no, author_member_id, description, category, expense_date,
        currency, amount, split_type, split_params, receipt_id)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, 'equal', '{"kind":"equal"}'::jsonb, $9)`,
    [
      versionId,
      expenseId,
      participants[0] ?? null,
      description,
      category,
      date,
      currency,
      amount.toString(),
      receiptId,
    ],
  );
  for (const [memberId, paid] of Object.entries(payers)) {
    await client.query(
      `INSERT INTO expense_payers (id, expense_version_id, member_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), versionId, memberId, paid.toString()],
    );
  }
  for (const [memberId, owed] of shares) {
    await client.query(
      `INSERT INTO expense_shares (id, expense_version_id, member_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), versionId, memberId, owed.toString()],
    );
  }
  await client.query(`UPDATE expenses SET current_version_id = $1 WHERE id = $2`, [
    versionId,
    expenseId,
  ]);
  await client.query('COMMIT');

  return { expenseId, versionId, shares };
}

export async function readBalances(client: Client, groupId: string): Promise<Map<string, bigint>> {
  const result = await client.query(
    `SELECT member_id, balance FROM group_balances WHERE group_id = $1`,
    [groupId],
  );
  return new Map(result.rows.map((row) => [String(row.member_id), big(row.balance)]));
}

export async function readTruth(client: Client, groupId: string): Promise<Map<string, bigint>> {
  const result = await client.query(
    `SELECT member_id, balance FROM baaki_group_balances_truth($1)`,
    [groupId],
  );
  return new Map(result.rows.map((row) => [String(row.member_id), big(row.balance)]));
}

export async function readPairwise(
  client: Client,
  groupId: string,
): Promise<{ from: string; to: string; amount: bigint }[]> {
  const result = await client.query(
    `SELECT from_member_id, to_member_id, amount FROM pairwise_balances
      WHERE group_id = $1 ORDER BY from_member_id, to_member_id`,
    [groupId],
  );
  return result.rows.map((row) => ({
    from: String(row.from_member_id),
    to: String(row.to_member_id),
    amount: big(row.amount),
  }));
}

/**
 * Run a callback as a Supabase-style role with a JWT claim set, inside a
 * transaction that is always rolled back.
 */
export async function asRole<T>(
  client: Client,
  role: 'authenticated' | 'anon' | 'service_role',
  claims: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(claims),
    ]);
    await client.query(`SET LOCAL ROLE ${role}`);
    return await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

export async function expectDenied(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected the statement to be denied, but it succeeded');
}
