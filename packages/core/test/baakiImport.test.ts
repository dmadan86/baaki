/**
 * "export re-imports losslessly" — the last line of M5's acceptance criteria.
 *
 * The test builds an export the way `supabase/functions/export-data` builds
 * one, reads it back, and asserts that every person's balance in every
 * currency is bit-for-bit what it was. That is what "lossless" is allowed to
 * mean here, and the rest of these tests pin the places where a file could
 * plausibly say something the ledger never did.
 */

import { describe, expect, it } from 'vitest';

import {
  balancesOf,
  isBaakiExport,
  parseBaakiExport,
  type BaakiImportGroup,
} from '../src/import/baaki.js';

interface Member {
  id: string;
  name: string;
  ghost?: boolean;
}

/** The shape `export-data` writes, at the size a test can read. */
function exportFile(options: {
  members: Member[];
  expenses: {
    id: string;
    description: string;
    category?: string | null;
    date?: string;
    currency?: string;
    amount: string;
    payers: Record<string, string>;
    shares: Record<string, string>;
    deleted?: boolean;
    /** An older version, kept by ADR-004 and not to be re-imported. */
    previous?: { amount: string; payers: Record<string, string>; shares: Record<string, string> };
  }[];
  settlements?: {
    from: string;
    to: string;
    amount: string;
    currency?: string;
    status?: string;
  }[];
  schemaVersion?: number;
}): string {
  const rows = (values: Record<string, string>): { member_id: string; amount: string }[] =>
    Object.entries(values).map(([member_id, amount]) => ({ member_id, amount }));

  return JSON.stringify({
    exportedAt: '2026-08-07T10:00:00.000Z',
    schemaVersion: options.schemaVersion ?? 1,
    amountUnit: 'minor',
    groups: [
      {
        group: { id: 'g1', name: 'Goa trip', default_currency: 'INR' },
        members: options.members.map((member) => ({
          id: member.id,
          ghost_name: member.ghost ? member.name : null,
          profile: member.ghost ? null : { display_name: member.name },
        })),
        expenses: options.expenses.map((expense) => ({
          id: expense.id,
          current_version_id: `${expense.id}v2`,
          deleted_at: expense.deleted ? '2026-08-01T00:00:00.000Z' : null,
          versions: [
            ...(expense.previous
              ? [
                  {
                    id: `${expense.id}v1`,
                    version_no: 1,
                    description: expense.description,
                    category: expense.category ?? null,
                    expense_date: expense.date ?? '2026-03-01',
                    currency: expense.currency ?? 'INR',
                    amount: expense.previous.amount,
                    payers: rows(expense.previous.payers),
                    shares: rows(expense.previous.shares),
                  },
                ]
              : []),
            {
              id: `${expense.id}v2`,
              version_no: expense.previous ? 2 : 1,
              description: expense.description,
              category: expense.category ?? null,
              expense_date: expense.date ?? '2026-03-01',
              currency: expense.currency ?? 'INR',
              amount: expense.amount,
              payers: rows(expense.payers),
              shares: rows(expense.shares),
            },
          ],
        })),
        settlements: (options.settlements ?? []).map((settlement, index) => ({
          id: `s${index}`,
          from_member_id: settlement.from,
          to_member_id: settlement.to,
          currency: settlement.currency ?? 'INR',
          amount: settlement.amount,
          method: 'upi',
          status: settlement.status ?? 'confirmed',
          note: null,
          initiated_at: '2026-04-01T00:00:00.000Z',
          allocations: [],
        })),
        activity: [],
      },
    ],
  });
}

const asha: Member = { id: 'm1', name: 'Asha' };
const ravi: Member = { id: 'm2', name: 'Ravi' };
const priya: Member = { id: 'm3', name: 'Priya', ghost: true };

function only(text: string): BaakiImportGroup {
  const parsed = parseBaakiExport(text);
  expect(parsed.problems).toEqual([]);
  expect(parsed.groups).toHaveLength(1);
  return parsed.groups[0]!;
}

describe('a Baaki export, read back', () => {
  it('reproduces every balance exactly — expenses and settlements together', () => {
    const file = exportFile({
      members: [asha, ravi, priya],
      expenses: [
        {
          id: 'e1',
          description: 'Beach shack dinner',
          category: 'food',
          amount: '100000',
          payers: { m1: '100000' },
          // 100000 / 3 with the odd paisa on the first person — exactly what
          // the ledger stored, and not something to be divided again here.
          shares: { m1: '33334', m2: '33333', m3: '33333' },
        },
        {
          id: 'e2',
          description: 'Scooter hire',
          category: 'travel',
          amount: '60000',
          payers: { m2: '40000', m3: '20000' },
          shares: { m1: '20000', m2: '20000', m3: '20000' },
        },
      ],
      settlements: [{ from: 'm2', to: 'm1', amount: '5000' }],
    });

    const group = only(file);
    expect(group.expenses).toHaveLength(2);
    expect(group.settlements).toHaveLength(1);
    expect(group.people).toEqual(['Asha', 'Ravi', 'Priya']);

    // Worked out by hand from the rows above, which is the point: nothing in
    // the pipeline gets to decide these. A settlement moves the *payer's*
    // balance up and the payee's down — paying off a debt is what makes a
    // negative balance rise (TDR §3.3).
    expect(group.balances.INR).toEqual({
      Asha: 100000n - 33334n - 20000n - 5000n, //  41666
      Ravi: 40000n - 33333n - 20000n + 5000n, //   -8333
      Priya: 20000n - 33333n - 20000n, //         -33333
    });

    // The invariant every group has: what is owed is owed to somebody.
    const total = Object.values(group.balances.INR!).reduce((sum, value) => sum + value, 0n);
    expect(total).toBe(0n);
  });

  it('imports what an expense now says, not what it used to say', () => {
    const group = only(
      exportFile({
        members: [asha, ravi],
        expenses: [
          {
            id: 'e1',
            description: 'Dinner',
            amount: '80000',
            payers: { m1: '80000' },
            shares: { m1: '40000', m2: '40000' },
            previous: {
              amount: '20000',
              payers: { m1: '20000' },
              shares: { m1: '10000', m2: '10000' },
            },
          },
        ],
      }),
    );

    expect(group.expenses).toHaveLength(1);
    expect(group.expenses[0]!.amount).toBe(80000n);
    expect(group.balances.INR).toEqual({ Asha: 40000n, Ravi: -40000n });
  });

  it('leaves a deleted expense out', () => {
    const group = only(
      exportFile({
        members: [asha, ravi],
        expenses: [
          {
            id: 'e1',
            description: 'Dinner',
            amount: '80000',
            payers: { m1: '80000' },
            shares: { m1: '40000', m2: '40000' },
          },
          {
            id: 'e2',
            description: 'Cancelled booking',
            amount: '50000',
            payers: { m2: '50000' },
            shares: { m1: '25000', m2: '25000' },
            deleted: true,
          },
        ],
      }),
    );

    expect(group.expenses).toHaveLength(1);
    expect(group.balances.INR).toEqual({ Asha: 40000n, Ravi: -40000n });
  });

  it('counts only the settlements that settle', () => {
    const group = only(
      exportFile({
        members: [asha, ravi],
        expenses: [
          {
            id: 'e1',
            description: 'Dinner',
            amount: '80000',
            payers: { m1: '80000' },
            shares: { m1: '40000', m2: '40000' },
          },
        ],
        settlements: [
          { from: 'm2', to: 'm1', amount: '10000', status: 'initiated' },
          { from: 'm2', to: 'm1', amount: '5000', status: 'auto_confirmed' },
          { from: 'm2', to: 'm1', amount: '9999', status: 'cancelled' },
        ],
      }),
    );

    // All three are carried across as history; only the auto-confirmed one
    // moves a balance (TDR §3.3).
    expect(group.settlements).toHaveLength(3);
    expect(group.balances.INR).toEqual({ Asha: 35000n, Ravi: -35000n });
  });

  it('keeps currencies apart', () => {
    const group = only(
      exportFile({
        members: [asha, ravi],
        expenses: [
          {
            id: 'e1',
            description: 'Dinner',
            amount: '80000',
            payers: { m1: '80000' },
            shares: { m1: '40000', m2: '40000' },
          },
          {
            id: 'e2',
            description: 'Hostel',
            currency: 'EUR',
            amount: '4000',
            payers: { m2: '4000' },
            shares: { m1: '2000', m2: '2000' },
          },
        ],
      }),
    );

    expect(group.balances.INR).toEqual({ Asha: 40000n, Ravi: -40000n });
    expect(group.balances.EUR).toEqual({ Asha: -2000n, Ravi: 2000n });
  });

  it('tells two people with the same name apart instead of merging them', () => {
    // Merging them would silently combine two people's debts, and there is no
    // un-merging afterwards.
    const group = only(
      exportFile({
        members: [
          { id: 'm1', name: 'Ravi' },
          { id: 'm2', name: 'Ravi', ghost: true },
        ],
        expenses: [
          {
            id: 'e1',
            description: 'Dinner',
            amount: '60000',
            payers: { m1: '60000' },
            shares: { m1: '30000', m2: '30000' },
          },
        ],
      }),
    );

    expect(group.people).toEqual(['Ravi', 'Ravi (2)']);
    expect(group.balances.INR).toEqual({ Ravi: 30000n, 'Ravi (2)': -30000n });
  });

  it('names the row that does not add up and imports the rest', () => {
    const parsed = parseBaakiExport(
      exportFile({
        members: [asha, ravi],
        expenses: [
          {
            id: 'e1',
            description: 'Dinner',
            amount: '80000',
            payers: { m1: '80000' },
            shares: { m1: '40000', m2: '40000' },
          },
          {
            id: 'e2',
            description: 'Tampered',
            amount: '50000',
            payers: { m1: '50000' },
            shares: { m1: '25000', m2: '20000' },
          },
        ],
      }),
    );

    const group = parsed.groups[0]!;
    expect(group.expenses.map((expense) => expense.description)).toEqual(['Dinner']);
    expect(group.problems).toHaveLength(1);
    expect(group.problems[0]!.kind).toBe('row_does_not_balance');
    expect(group.problems[0]!.message).toContain('Tampered');
  });

  it('refuses a file from a newer version rather than dropping half of it', () => {
    const parsed = parseBaakiExport(
      exportFile({
        members: [asha, ravi],
        expenses: [],
        schemaVersion: 2,
      }),
    );
    expect(parsed.groups).toEqual([]);
    expect(parsed.problems[0]!.message).toContain('newer version');
  });

  it('says what a file is not', () => {
    expect(isBaakiExport('date,description,cost\n2026-01-01,Dinner,300')).toBe(false);
    expect(isBaakiExport('{')).toBe(false);
    expect(parseBaakiExport('not json at all').problems[0]!.kind).toBe('unparseable_row');
    expect(isBaakiExport(exportFile({ members: [asha], expenses: [] }))).toBe(true);
  });

  it('refuses a fractional amount instead of rounding somebody’s money', () => {
    const file = JSON.parse(
      exportFile({
        members: [asha, ravi],
        expenses: [
          {
            id: 'e1',
            description: 'Dinner',
            amount: '80000',
            payers: { m1: '80000' },
            shares: { m1: '40000', m2: '40000' },
          },
        ],
      }),
    ) as { groups: { expenses: { versions: { amount: unknown }[] }[] }[] };
    file.groups[0]!.expenses[0]!.versions[0]!.amount = 800.5;

    const group = parseBaakiExport(JSON.stringify(file)).groups[0]!;
    expect(group.expenses).toEqual([]);
    expect(group.problems[0]!.kind).toBe('unparseable_row');
  });
});

describe('balancesOf', () => {
  it('leaves out anybody who is square', () => {
    expect(
      balancesOf(
        [
          {
            description: 'Dinner',
            category: null,
            date: '2026-03-01',
            currency: 'INR',
            amount: 20000n,
            payers: { Asha: 10000n, Ravi: 10000n },
            shares: { Asha: 10000n, Ravi: 10000n },
          },
        ],
        [],
      ),
    ).toEqual({ INR: {} });
  });
});
