/**
 * "export re-imports losslessly" — M5's last acceptance line, proved against
 * the database rather than in the abstract.
 *
 * A group is built, settled against, exported the way `export-data` exports
 * it, and read back into a brand-new group by `baaki_import_ledger`. The
 * assertion is the only one that matters: every person's balance in the new
 * group equals their balance in the old one, to the paisa.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { parseBaakiExport } from '@waves/core';

import { addEqualSplitExpense, big, connect, readTruth, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

async function asUser<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query(`SET ROLE authenticated`);
  try {
    return await run();
  } finally {
    await client.query(`RESET ROLE`);
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

/** Balances keyed by the name each member goes by, so two groups can be compared. */
async function balancesByName(groupId: string): Promise<Record<string, bigint>> {
  const result = await client.query(
    `SELECT COALESCE(p.display_name, gm.ghost_name) AS name, b.currency, b.balance
       FROM baaki_group_balances_truth($1) b
       JOIN group_members gm ON gm.id = b.member_id
       LEFT JOIN profiles p ON p.id = gm.profile_id`,
    [groupId],
  );
  return Object.fromEntries(
    result.rows.map((row) => [`${String(row.name)}:${String(row.currency)}`, big(row.balance)]),
  );
}

/** Exactly the JSON `supabase/functions/export-data` writes, read from the database. */
async function exportGroup(groupId: string): Promise<string> {
  // One at a time: a single pg client cannot run these in parallel, and
  // `Promise.all` over it only earns a deprecation warning.
  const group = await client.query(`SELECT * FROM groups WHERE id = $1`, [groupId]);
  const members = await client.query(
    `SELECT gm.*, CASE WHEN p.id IS NULL THEN NULL
                         ELSE jsonb_build_object('display_name', p.display_name) END AS profile
         FROM group_members gm LEFT JOIN profiles p ON p.id = gm.profile_id
        WHERE gm.group_id = $1 ORDER BY gm.created_at`,
    [groupId],
  );
  const expenses = await client.query(
    `SELECT e.*, (
         SELECT jsonb_agg(jsonb_build_object(
           'id', ev.id, 'version_no', ev.version_no, 'description', ev.description,
           'category', ev.category, 'expense_date', ev.expense_date, 'currency', ev.currency,
           'amount', ev.amount::text,
           'payers', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'member_id', ep.member_id, 'amount', ep.amount::text)), '[]'::jsonb)
                        FROM expense_payers ep WHERE ep.expense_version_id = ev.id),
           'shares', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'member_id', es.member_id, 'amount', es.amount::text)), '[]'::jsonb)
                        FROM expense_shares es WHERE es.expense_version_id = ev.id)))
         FROM expense_versions ev WHERE ev.expense_id = e.id) AS versions
         FROM expenses e WHERE e.group_id = $1`,
    [groupId],
  );
  const settlements = await client.query(
    `SELECT id, from_member_id, to_member_id, currency, amount::text, method, status, note,
            initiated_at
       FROM settlements WHERE group_id = $1`,
    [groupId],
  );

  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    amountUnit: 'minor',
    groups: [
      {
        group: group.rows[0],
        members: members.rows,
        expenses: expenses.rows,
        settlements: settlements.rows,
        activity: [],
      },
    ],
  });
}

describe('a Baaki export, imported back', () => {
  it('reproduces every balance exactly, in a group that never existed before', async () => {
    const seeded = await seedGroup(client, { memberCount: 3, ghostCount: 1 });
    const [asha, ravi, priya, ghost] = seeded.memberIds as [string, string, string, string];

    // A three-way split with an odd paisa, a multi-payer expense, and a ghost
    // who owes — the three shapes that a lossy import would round away.
    await addEqualSplitExpense(client, {
      groupId: seeded.groupId,
      amount: 100000n,
      payers: { [asha]: 100000n },
      participants: [asha, ravi, priya],
      category: 'food',
    });
    await addEqualSplitExpense(client, {
      groupId: seeded.groupId,
      amount: 60000n,
      payers: { [ravi]: 40000n, [priya]: 20000n },
      participants: [asha, ravi, priya, ghost],
      category: 'travel',
    });
    await addEqualSplitExpense(client, {
      groupId: seeded.groupId,
      amount: 4000n,
      payers: { [asha]: 4000n },
      participants: [asha, ravi],
      currency: 'EUR',
      category: 'stay',
    });

    await client.query(
      `INSERT INTO settlements
         (group_id, from_member_id, to_member_id, currency, amount, method, status, confirmed_at)
       VALUES ($1, $2, $3, 'INR', 5000, 'upi', 'confirmed', now())`,
      [seeded.groupId, ravi, asha],
    );
    // An unconfirmed one, which must be carried across as history without
    // moving a single balance (TDR §3.3).
    await client.query(
      `INSERT INTO settlements
         (group_id, from_member_id, to_member_id, currency, amount, method, status)
       VALUES ($1, $2, $3, 'INR', 9999, 'cash', 'initiated')`,
      [seeded.groupId, priya, asha],
    );

    const before = await balancesByName(seeded.groupId);
    expect(Object.keys(before).length).toBeGreaterThan(0);

    const parsed = parseBaakiExport(await exportGroup(seeded.groupId));
    expect(parsed.problems).toEqual([]);
    const exported = parsed.groups[0]!;
    expect(exported.expenses).toHaveLength(3);
    expect(exported.settlements).toHaveLength(2);

    // The importer is somebody with no history at all, which is the real case:
    // a new phone, a new account, a file.
    const importer = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Importer')`, [
      importer,
    ]);

    const newGroupId = await asUser(importer, async () => {
      const created = await client.query(
        `SELECT baaki_create_group('Imported trip', 'trip', 'INR', NULL, true) AS id`,
      );
      const groupId = String(created.rows[0]!.id);

      await client.query(
        `SELECT baaki_import_ledger($1, $2::jsonb, $3::jsonb, $4::jsonb, 'baaki')`,
        [
          groupId,
          JSON.stringify(exported.people.map((name) => ({ name, memberId: null }))),
          JSON.stringify(
            exported.expenses.map((expense) => ({
              clientMutationId: randomUUID(),
              description: expense.description,
              category: expense.category,
              date: expense.date,
              currency: expense.currency,
              amount: expense.amount.toString(),
              payers: asStrings(expense.payers),
              shares: asStrings(expense.shares),
            })),
          ),
          JSON.stringify(
            exported.settlements.map((settlement) => ({
              clientMutationId: randomUUID(),
              from: settlement.from,
              to: settlement.to,
              currency: settlement.currency,
              amount: settlement.amount.toString(),
              method: settlement.method,
              status: settlement.status,
              note: settlement.note,
              at: settlement.at,
            })),
          ),
        ],
      );
      return groupId;
    });

    const after = await balancesByName(newGroupId);
    expect(after).toEqual(before);

    // And the file's own arithmetic agreed with the database's all along —
    // which is what lets the import screen show a preview that can be trusted.
    const fromFile = Object.fromEntries(
      Object.entries(exported.balances).flatMap(([currency, people]) =>
        Object.entries(people).map(([name, value]) => [`${name}:${currency}`, value]),
      ),
    );
    expect(fromFile).toEqual(before);
  });

  it('does not pay anybody twice when an import is replayed', async () => {
    const seeded = await seedGroup(client, { memberCount: 2 });
    const [asha, ravi] = seeded.memberIds as [string, string];
    await addEqualSplitExpense(client, {
      groupId: seeded.groupId,
      amount: 20000n,
      payers: { [asha]: 20000n },
      participants: [asha, ravi],
    });
    await client.query(
      `INSERT INTO settlements
         (group_id, from_member_id, to_member_id, currency, amount, method, status, confirmed_at)
       VALUES ($1, $2, $3, 'INR', 1000, 'cash', 'confirmed', now())`,
      [seeded.groupId, ravi, asha],
    );

    const exported = parseBaakiExport(await exportGroup(seeded.groupId)).groups[0]!;
    const importer = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Twice')`, [importer]);

    // The same mutation ids both times: a lost response and a second tap look
    // identical from here, and neither may double the ledger (ADR-005).
    const expenseIds = exported.expenses.map(() => randomUUID());
    const settlementIds = exported.settlements.map(() => randomUUID());

    const run = async (groupId: string): Promise<void> => {
      await client.query(
        `SELECT baaki_import_ledger($1, $2::jsonb, $3::jsonb, $4::jsonb, 'baaki')`,
        [
          groupId,
          JSON.stringify(exported.people.map((name) => ({ name, memberId: null }))),
          JSON.stringify(
            exported.expenses.map((expense, index) => ({
              clientMutationId: expenseIds[index],
              description: expense.description,
              category: expense.category,
              date: expense.date,
              currency: expense.currency,
              amount: expense.amount.toString(),
              payers: asStrings(expense.payers),
              shares: asStrings(expense.shares),
            })),
          ),
          JSON.stringify(
            exported.settlements.map((settlement, index) => ({
              clientMutationId: settlementIds[index],
              from: settlement.from,
              to: settlement.to,
              currency: settlement.currency,
              amount: settlement.amount.toString(),
              method: settlement.method,
              status: settlement.status,
              at: settlement.at,
            })),
          ),
        ],
      );
    };

    const newGroupId = await asUser(importer, async () => {
      const created = await client.query(
        `SELECT baaki_create_group('Twice over', 'trip', 'INR', NULL, true) AS id`,
      );
      const groupId = String(created.rows[0]!.id);
      await run(groupId);
      await run(groupId);
      return groupId;
    });

    const settlements = await client.query(
      `SELECT count(*)::int AS n FROM settlements WHERE group_id = $1`,
      [newGroupId],
    );
    const expenses = await client.query(
      `SELECT count(*)::int AS n FROM expenses WHERE group_id = $1`,
      [newGroupId],
    );
    expect(settlements.rows[0]!.n).toBe(1);
    expect(expenses.rows[0]!.n).toBe(1);
  });

  it('refuses a file naming somebody who is not in the people list', async () => {
    const importer = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Careful')`, [
      importer,
    ]);

    await expect(
      asUser(importer, async () => {
        const created = await client.query(
          `SELECT baaki_create_group('Broken', 'trip', 'INR', NULL, true) AS id`,
        );
        await client.query(
          `SELECT baaki_import_ledger($1, $2::jsonb, $3::jsonb, '[]'::jsonb, 'baaki')`,
          [
            String(created.rows[0]!.id),
            JSON.stringify([{ name: 'Asha', memberId: null }]),
            JSON.stringify([
              {
                clientMutationId: randomUUID(),
                description: 'Dinner',
                category: null,
                date: '2026-03-01',
                currency: 'INR',
                amount: '20000',
                payers: { Asha: '20000' },
                shares: { Asha: '10000', Nobody: '10000' },
              },
            ]),
          ],
        );
      }),
    ).rejects.toThrow(/UNKNOWN_MEMBER/);
  });

  it('still imports a Splitwise file through the same path', async () => {
    const importer = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Switcher')`, [
      importer,
    ]);

    const result = await asUser(importer, async () => {
      const created = await client.query(
        `SELECT baaki_create_group('From Splitwise', 'trip', 'INR', NULL, true) AS id`,
      );
      const groupId = String(created.rows[0]!.id);
      const imported = await client.query(
        `SELECT baaki_import_splitwise($1, $2::jsonb, $3::jsonb) AS result`,
        [
          groupId,
          JSON.stringify([
            { name: 'Asha', memberId: null },
            { name: 'Ravi', memberId: null },
          ]),
          JSON.stringify([
            {
              clientMutationId: randomUUID(),
              description: 'Dinner',
              category: 'food',
              date: '2026-03-01',
              currency: 'INR',
              amount: '20000',
              payers: { Asha: '20000' },
              shares: { Asha: '10000', Ravi: '10000' },
            },
          ]),
        ],
      );
      return imported.rows[0]!.result as { expenses: number; ghosts: number };
    });

    expect(result.expenses).toBe(1);
    expect(result.ghosts).toBe(2);
  });
});

function asStrings(values: Readonly<Record<string, bigint>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, value.toString()]),
  );
}

/**
 * A settlement the file calls settled is only settled if somebody who can vouch
 * for the receipt is doing the import (ADR-007). Before this rule any member
 * could import `{from: me, to: <a member>, status: "confirmed"}` and erase a
 * debt without the payee ever seeing it — the transition guard is BEFORE
 * UPDATE, so a row born confirmed was never looked at.
 */
describe('imported settlements and consent', () => {
  interface Row {
    status: string;
    confirmed_at: string | null;
    initiated_at: string;
  }

  async function importSettlements(
    importerProfile: string,
    groupId: string,
    people: { name: string; memberId: string | null }[],
    settlements: Record<string, unknown>[],
  ): Promise<{ settlementsPending: number; settlements: number }> {
    return asUser(importerProfile, async () => {
      const result = await client.query(
        `SELECT baaki_import_ledger($1, $2::jsonb, '[]'::jsonb, $3::jsonb, 'baaki') AS r`,
        [
          groupId,
          JSON.stringify(people),
          JSON.stringify(
            settlements.map((settlement) => ({
              clientMutationId: randomUUID(),
              currency: 'INR',
              amount: '900000',
              method: 'cash',
              status: 'confirmed',
              at: '2024-01-01T00:00:00Z',
              ...settlement,
            })),
          ),
        ],
      );
      return result.rows[0]!.r as { settlementsPending: number; settlements: number };
    });
  }

  async function rows(groupId: string): Promise<Row[]> {
    const result = await client.query(
      `SELECT status, confirmed_at, initiated_at FROM settlements
        WHERE group_id = $1 ORDER BY created_at`,
      [groupId],
    );
    return result.rows as Row[];
  }

  it('does not let the payer import their own debt as already paid', async () => {
    const seeded = await seedGroup(client, { memberCount: 2 });
    const [me, victim] = seeded.memberIds as [string, string];
    await addEqualSplitExpense(client, {
      groupId: seeded.groupId,
      amount: 900000n,
      payers: { [victim]: 900000n },
      participants: [me],
    });
    const before = await readTruth(client, seeded.groupId);

    const result = await importSettlements(
      seeded.profileIds[0]!,
      seeded.groupId,
      [
        { name: 'Me', memberId: me },
        { name: 'Victim', memberId: victim },
      ],
      [{ from: 'Me', to: 'Victim' }],
    );

    // Lands pending, for the payee to confirm — and dated now, not with the
    // file's date, or the auto-confirm job would settle it on its next run.
    expect(result).toMatchObject({ settlements: 1, settlementsPending: 1 });
    const [row] = await rows(seeded.groupId);
    expect(row).toMatchObject({ status: 'initiated', confirmed_at: null });
    expect(Date.now() - new Date(row!.initiated_at).getTime()).toBeLessThan(60_000);
    expect(await readTruth(client, seeded.groupId)).toEqual(before);
  });

  it('lets the payee vouch for a payment they received', async () => {
    const seeded = await seedGroup(client, { memberCount: 2 });
    const [me, payer] = seeded.memberIds as [string, string];

    const result = await importSettlements(
      seeded.profileIds[0]!,
      seeded.groupId,
      [
        { name: 'Me', memberId: me },
        { name: 'Payer', memberId: payer },
      ],
      [{ from: 'Payer', to: 'Me' }],
    );

    expect(result).toMatchObject({ settlements: 1, settlementsPending: 0 });
    const [row] = await rows(seeded.groupId);
    expect(row!.status).toBe('confirmed');
    // The file's date survives on a settled row.
    expect(new Date(row!.confirmed_at!).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('takes the importer at their word for ghosts, and nobody else', async () => {
    const seeded = await seedGroup(client, { memberCount: 2 });
    const [me, other] = seeded.memberIds as [string, string];

    const result = await importSettlements(
      seeded.profileIds[0]!,
      seeded.groupId,
      [
        { name: 'Me', memberId: me },
        { name: 'Other', memberId: other },
        { name: 'Ghost A', memberId: null },
        { name: 'Ghost B', memberId: null },
      ],
      [
        { from: 'Ghost A', to: 'Ghost B' }, // ghosts settling among themselves
        { from: 'Me', to: 'Ghost A' }, // the importer paid a ghost
        { from: 'Ghost A', to: 'Me' }, // a ghost paid the importer
        { from: 'Other', to: 'Ghost B' }, // somebody on Waves "paid" a ghost — their claim to make
        { from: 'Ghost B', to: 'Other' }, // a ghost "paid" somebody on Waves — theirs to confirm
        { from: 'Other', to: 'Me', status: 'auto_confirmed' }, // settled in the file, payee imports
      ],
    );

    expect(result).toMatchObject({ settlements: 6, settlementsPending: 2 });
    expect((await rows(seeded.groupId)).map((row) => row.status)).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
      'initiated',
      'initiated',
      'confirmed',
    ]);
  });

  it('carries a pending or cancelled row across as history, and refuses a made-up status', async () => {
    const seeded = await seedGroup(client, { memberCount: 1 });
    const [me] = seeded.memberIds as [string];
    const people = [
      { name: 'Me', memberId: me },
      { name: 'Ghost', memberId: null },
    ];

    const result = await importSettlements(seeded.profileIds[0]!, seeded.groupId, people, [
      { from: 'Ghost', to: 'Me', status: 'initiated' },
      { from: 'Ghost', to: 'Me', status: 'cancelled' },
    ]);
    expect(result).toMatchObject({ settlements: 2, settlementsPending: 1 });
    expect((await rows(seeded.groupId)).map((row) => row.status)).toEqual([
      'initiated',
      'cancelled',
    ]);

    await expect(
      importSettlements(seeded.profileIds[0]!, seeded.groupId, people, [
        { from: 'Ghost', to: 'Me', status: 'settled' },
      ]),
    ).rejects.toThrow(/INVALID_STATUS/);
  });
});
