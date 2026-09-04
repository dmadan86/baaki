/**
 * The admin console's reads, and who is allowed to make them.
 *
 * The grants are the point. Postgres gives EXECUTE to PUBLIC on every new
 * function, and `anon` and `authenticated` inherit PUBLIC in Supabase — so a
 * missing REVOKE does not fail loudly, it quietly publishes the whole business
 * behind the anon key that ships inside the app binary. That is a one-line
 * mistake with no symptom, which is exactly the kind worth a test.
 *
 * The arithmetic is checked too, against rows this file seeds, because a
 * dashboard that is confidently wrong is worse than one that is empty.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, connect, expectDenied, seedGroup } from './helpers';

let client: Client;

const FUNCTIONS = [
  'waves_admin_overview()',
  'waves_admin_daily(30)',
  'waves_admin_geo()',
  'waves_admin_money()',
  'waves_admin_ai_cost(30)',
  'waves_admin_logins(30)',
];

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/** Runs one statement as a role, then puts the connection back. */
async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    return await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('who may read the business', () => {
  it('refuses anon on every function', async () => {
    for (const fn of FUNCTIONS) {
      const message = await asRole('anon', () =>
        expectDenied(client.query(`SELECT * FROM public.${fn}`)),
      );
      expect(message, fn).toMatch(/permission denied/i);
    }
  });

  it('refuses a signed-in user on every function', async () => {
    // The one that matters most. Every Waves account is signed in, including
    // the anonymous guests ADR-006 hands out for free — "authenticated" is not
    // a privilege here, it is the default.
    for (const fn of FUNCTIONS) {
      const message = await asRole('authenticated', () =>
        expectDenied(client.query(`SELECT * FROM public.${fn}`)),
      );
      expect(message, fn).toMatch(/permission denied/i);
    }
  });

  it('allows the service role', async () => {
    for (const fn of FUNCTIONS) {
      await asRole('service_role', async () => {
        await expect(client.query(`SELECT * FROM public.${fn}`)).resolves.toBeDefined();
      });
    }
  });
});

describe('the numbers', () => {
  it('counts people, groups and live expenses', async () => {
    const before = (await client.query('SELECT * FROM public.waves_admin_overview()')).rows[0];

    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const expenseId = await addExpense(client, groupId, memberIds[0]!, 'INR', 45000n);

    const after = (await client.query('SELECT * FROM public.waves_admin_overview()')).rows[0];

    expect(Number(after.profiles_total)).toBe(Number(before.profiles_total) + 2);
    expect(Number(after.groups_total)).toBe(Number(before.groups_total) + 1);
    expect(Number(after.expenses_total)).toBe(Number(before.expenses_total) + 1);

    // A soft-deleted expense leaves the live count and joins the deleted one.
    await client.query('UPDATE public.expenses SET deleted_at = now() WHERE id = $1', [expenseId]);
    const deleted = (await client.query('SELECT * FROM public.waves_admin_overview()')).rows[0];
    expect(Number(deleted.expenses_total)).toBe(Number(after.expenses_total) - 1);
    expect(Number(deleted.expenses_deleted)).toBe(Number(after.expenses_deleted) + 1);
  });

  it('keeps a day with nothing in it', async () => {
    // The reason this is generate_series and not GROUP BY: a chart drawn from
    // grouped rows closes its own gaps, and a flat fortnight is information.
    const { rows } = await client.query('SELECT * FROM public.waves_admin_daily(14)');
    expect(rows).toHaveLength(14);

    const days = rows.map((row) => String(row.day instanceof Date ? isoDay(row.day) : row.day));
    expect(new Set(days).size).toBe(14);
    expect(days).toEqual([...days].sort());
  });

  it('never adds one currency to another', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    await addExpense(client, groupId, memberIds[0]!, 'INR', 10_000n);
    await addExpense(client, groupId, memberIds[0]!, 'AED', 700n);

    const { rows } = await client.query('SELECT * FROM public.waves_admin_money()');
    const inr = rows.find((row) => row.currency === 'INR');
    const aed = rows.find((row) => row.currency === 'AED');

    expect(inr).toBeDefined();
    expect(aed).toBeDefined();
    // Separate rows, and the AED row cannot have absorbed the rupees.
    expect(BigInt(aed!.expense_minor)).toBeGreaterThanOrEqual(700n);
    expect(BigInt(inr!.expense_minor)).toBeGreaterThanOrEqual(10_000n);
    expect(rows.every((row) => typeof row.currency === 'string' && row.currency.length === 3)).toBe(
      true,
    );
  });

  it('counts an edited expense once, at its current version', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const expenseId = await addExpense(client, groupId, memberIds[0]!, 'SGD', 5_000n);

    const before = await currencyTotal(client, 'SGD');
    await addVersion(client, expenseId, memberIds[0]!, 'SGD', 9_000n, 2);
    const after = await currencyTotal(client, 'SGD');

    // 5000 replaced by 9000, not 5000 + 9000.
    expect(after - before).toBe(4_000n);
  });

  it('reports an unknown country as its own row rather than dropping it', async () => {
    await seedGroup(client, { memberCount: 1 });
    const { rows } = await client.query('SELECT * FROM public.waves_admin_geo()');
    expect(rows.some((row) => row.country_code === null)).toBe(true);
  });

  it('returns nothing for logins on a database with no auth schema', async () => {
    // CI is bare Postgres. The function must answer rather than raise — an
    // admin console that 500s on a machine without Supabase's auth schema is
    // one nobody can develop against.
    const { rows } = await client.query('SELECT * FROM public.waves_admin_logins(30)');
    expect(Array.isArray(rows)).toBe(true);
  });
});

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

async function currencyTotal(db: Client, currency: string): Promise<bigint> {
  const { rows } = await db.query(
    'SELECT expense_minor FROM public.waves_admin_money() WHERE currency = $1',
    [currency],
  );
  return rows[0] ? BigInt(rows[0].expense_minor) : 0n;
}

/**
 * One expense, through the repo's own helper.
 *
 * Hand-rolling the inserts here did not work and should not have: a trigger
 * checks that the payers sum to the amount, so an expense seeded without them
 * is rejected — `PAYER_MISMATCH: payers sum to 0 but the expense is 10000`.
 * That guard is the ledger's, and a test fixture that sidestepped it would be
 * measuring rows the app can never produce.
 */
async function addExpense(
  db: Client,
  groupId: string,
  memberId: string,
  currency: string,
  amount: bigint,
): Promise<string> {
  const { expenseId } = await addEqualSplitExpense(db, {
    groupId,
    payers: { [memberId]: amount },
    participants: [memberId],
    amount,
    currency,
  });
  return expenseId;
}

/** A second version of an existing expense, payers and shares included. */
async function addVersion(
  db: Client,
  expenseId: string,
  memberId: string,
  currency: string,
  amount: bigint,
  versionNo: number,
): Promise<void> {
  const versionId = randomUUID();
  await db.query('BEGIN');
  try {
    await db.query(
      `INSERT INTO public.expense_versions
         (id, expense_id, version_no, author_member_id, description, expense_date,
          currency, amount, split_type, split_params)
       VALUES ($1, $2, $3, $4, 'Dinner', current_date, $5, $6, 'equal', '{"kind":"equal"}'::jsonb)`,
      [versionId, expenseId, versionNo, memberId, currency, amount.toString()],
    );
    await db.query(
      `INSERT INTO public.expense_payers (id, expense_version_id, member_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), versionId, memberId, amount.toString()],
    );
    await db.query(
      `INSERT INTO public.expense_shares (id, expense_version_id, member_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), versionId, memberId, amount.toString()],
    );
    await db.query('UPDATE public.expenses SET current_version_id = $1 WHERE id = $2', [
      versionId,
      expenseId,
    ]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
