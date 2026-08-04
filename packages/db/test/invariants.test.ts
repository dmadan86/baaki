/**
 * ADR-004 / ADR-014: the database's derived balances must equal the
 * ground-truth aggregate, must sum to zero, and must agree with @baaki/core.
 * If any of these fail, the product promise ("your baaki is always right")
 * is broken, so CI blocks the merge.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { computeNetBalances, computePairwiseBalances } from '@baaki/core';

import {
  addEqualSplitExpense,
  big,
  connect,
  expectDenied,
  readBalances,
  readPairwise,
  readTruth,
  seedGroup,
} from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

describe('derived balances', () => {
  it('match the ground-truth aggregate and sum to zero', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 3 });
    const [asha, ravi, priya] = memberIds as [string, string, string];

    await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n, // ₹100 across three people → 3334 / 3333 / 3333
      payers: { [asha]: 10000n },
      participants: [asha, ravi, priya],
    });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 45000n,
      payers: { [ravi]: 20000n, [priya]: 25000n },
      participants: [asha, ravi, priya],
      description: 'Hotel',
      date: '2026-03-02',
    });

    const stored = await readBalances(client, groupId);
    const truth = await readTruth(client, groupId);
    expect([...stored.entries()].sort()).toEqual([...truth.entries()].sort());

    let total = 0n;
    for (const balance of stored.values()) total += balance;
    expect(total).toBe(0n);
  });

  it('agree exactly with @baaki/core for the same ledger', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 4 });
    const [a, b, c, d] = memberIds as [string, string, string, string];

    const first = await addEqualSplitExpense(client, {
      groupId,
      amount: 100001n, // deliberately indivisible by 4
      payers: { [a]: 100001n },
      participants: [a, b, c, d],
    });
    const second = await addEqualSplitExpense(client, {
      groupId,
      amount: 7777n,
      payers: { [b]: 4000n, [c]: 3777n },
      participants: [a, b, c],
      description: 'Auto',
      date: '2026-03-05',
    });

    const expected = computeNetBalances(
      [
        {
          id: first.expenseId,
          currency: 'INR',
          amount: 100001n,
          payers: { [a]: 100001n },
          shares: Object.fromEntries(first.shares),
          date: '2026-03-01',
        },
        {
          id: second.expenseId,
          currency: 'INR',
          amount: 7777n,
          payers: { [b]: 4000n, [c]: 3777n },
          shares: Object.fromEntries(second.shares),
          date: '2026-03-05',
        },
      ],
      [],
    );

    const stored = await readBalances(client, groupId);
    for (const member of [a, b, c, d]) {
      expect(stored.get(member) ?? 0n).toBe(expected.get('INR')?.get(member) ?? 0n);
    }
  });

  it('produce the same pairwise edges as @baaki/core', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 3 });
    const [a, b, c] = memberIds as [string, string, string];

    const expense = await addEqualSplitExpense(client, {
      groupId,
      amount: 30000n,
      payers: { [a]: 20000n, [b]: 10000n },
      participants: [a, b, c],
    });

    const expected = computePairwiseBalances(
      [
        {
          id: expense.expenseId,
          currency: 'INR',
          amount: 30000n,
          payers: { [a]: 20000n, [b]: 10000n },
          shares: Object.fromEntries(expense.shares),
          date: '2026-03-01',
        },
      ],
      [],
    );

    const stored = await readPairwise(client, groupId);
    expect(stored.map((edge) => `${edge.from}->${edge.to}:${edge.amount}`).sort()).toEqual(
      expected.map((edge) => `${edge.from}->${edge.to}:${edge.amount}`).sort(),
    );
  });

  it('drop soft-deleted expenses and restore them again', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const { expenseId } = await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [a]: 10000n },
      participants: [a, b],
    });
    expect((await readBalances(client, groupId)).get(b)).toBe(-5000n);

    await client.query(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, [expenseId]);
    expect((await readBalances(client, groupId)).size).toBe(0);

    await client.query(`UPDATE expenses SET deleted_at = NULL WHERE id = $1`, [expenseId]);
    expect((await readBalances(client, groupId)).get(b)).toBe(-5000n);
  });

  it('count confirmed settlements but not pending ones', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [a]: 10000n },
      participants: [a, b],
    });

    const settlementId = randomUUID();
    await client.query(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method, status)
       VALUES ($1, $2, $3, $4, 'INR', 5000, 'upi', 'initiated')`,
      [settlementId, groupId, b, a],
    );
    expect((await readBalances(client, groupId)).get(b)).toBe(-5000n);

    await client.query(`UPDATE settlements SET status = 'confirmed' WHERE id = $1`, [settlementId]);
    expect((await readBalances(client, groupId)).size).toBe(0);
  });
});

describe('money invariants (ADR-003)', () => {
  it('rejects shares that do not sum to the expense total', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const expenseId = randomUUID();
    const versionId = randomUUID();

    await client.query('BEGIN');
    const message = await expectDenied(
      (async () => {
        await client.query(`INSERT INTO expenses (id, group_id) VALUES ($1, $2)`, [
          expenseId,
          groupId,
        ]);
        await client.query(
          `INSERT INTO expense_versions
             (id, expense_id, version_no, description, expense_date, currency, amount, split_type, split_params)
           VALUES ($1, $2, 1, 'Bad', '2026-03-01', 'INR', 10000, 'equal', '{}'::jsonb)`,
          [versionId, expenseId],
        );
        await client.query(
          `INSERT INTO expense_payers (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, 10000)`,
          [randomUUID(), versionId, a],
        );
        await client.query(
          `INSERT INTO expense_shares (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, 4000)`,
          [randomUUID(), versionId, b],
        );
        await client.query('COMMIT');
      })(),
    );
    expect(message).toMatch(/SHARE_MISMATCH/);
    await client.query('ROLLBACK');
  });

  it('rejects payers that do not sum to the expense total', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const expenseId = randomUUID();
    const versionId = randomUUID();

    await client.query('BEGIN');
    const message = await expectDenied(
      (async () => {
        await client.query(`INSERT INTO expenses (id, group_id) VALUES ($1, $2)`, [
          expenseId,
          groupId,
        ]);
        await client.query(
          `INSERT INTO expense_versions
             (id, expense_id, version_no, description, expense_date, currency, amount, split_type, split_params)
           VALUES ($1, $2, 1, 'Bad', '2026-03-01', 'INR', 10000, 'equal', '{}'::jsonb)`,
          [versionId, expenseId],
        );
        await client.query(
          `INSERT INTO expense_payers (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, 9000)`,
          [randomUUID(), versionId, a],
        );
        for (const member of [a, b]) {
          await client.query(
            `INSERT INTO expense_shares (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, 5000)`,
            [randomUUID(), versionId, member],
          );
        }
        await client.query('COMMIT');
      })(),
    );
    expect(message).toMatch(/PAYER_MISMATCH/);
    await client.query('ROLLBACK');
  });
});

describe('append-only ledger (ADR-004)', () => {
  it('refuses to update or delete an expense version', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const { versionId, expenseId } = await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [a]: 10000n },
      participants: [a, b],
    });

    expect(
      await expectDenied(
        client.query(`UPDATE expense_versions SET description = 'Rewritten' WHERE id = $1`, [
          versionId,
        ]),
      ),
    ).toMatch(/APPEND_ONLY/);

    expect(
      await expectDenied(client.query(`DELETE FROM expenses WHERE id = $1`, [expenseId])),
    ).toMatch(/APPEND_ONLY/);
  });

  it('refuses to hard-delete a settlement', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const settlementId = randomUUID();
    await client.query(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method)
       VALUES ($1, $2, $3, $4, 'INR', 1000, 'cash')`,
      [settlementId, groupId, a, b],
    );
    expect(
      await expectDenied(client.query(`DELETE FROM settlements WHERE id = $1`, [settlementId])),
    ).toMatch(/APPEND_ONLY/);
  });
});

describe('settlement state machine (ADR-007)', () => {
  it('allows initiated → confirmed and stamps confirmed_at', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const settlementId = randomUUID();
    await client.query(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method)
       VALUES ($1, $2, $3, $4, 'INR', 1000, 'upi')`,
      [settlementId, groupId, a, b],
    );
    await client.query(`UPDATE settlements SET status = 'confirmed' WHERE id = $1`, [settlementId]);
    const result = await client.query(`SELECT confirmed_at FROM settlements WHERE id = $1`, [
      settlementId,
    ]);
    expect(result.rows[0]?.confirmed_at).toBeTruthy();
  });

  it('refuses an illegal transition', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const settlementId = randomUUID();
    await client.query(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method, status)
       VALUES ($1, $2, $3, $4, 'INR', 1000, 'upi', 'confirmed')`,
      [settlementId, groupId, a, b],
    );
    expect(
      await expectDenied(
        client.query(`UPDATE settlements SET status = 'cancelled' WHERE id = $1`, [settlementId]),
      ),
    ).toMatch(/INVALID_TRANSITION/);
  });

  it('never allocates more than the settlement amount', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const { expenseId } = await addEqualSplitExpense(client, {
      groupId,
      amount: 10000n,
      payers: { [a]: 10000n },
      participants: [a, b],
    });
    const settlementId = randomUUID();

    await client.query('BEGIN');
    const message = await expectDenied(
      (async () => {
        await client.query(
          `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method)
           VALUES ($1, $2, $3, $4, 'INR', 1000, 'upi')`,
          [settlementId, groupId, b, a],
        );
        await client.query(
          `INSERT INTO settlement_allocations (id, settlement_id, expense_id, amount)
           VALUES ($1, $2, $3, 5000)`,
          [randomUUID(), settlementId, expenseId],
        );
        await client.query('COMMIT');
      })(),
    );
    expect(message).toMatch(/ALLOCATION_EXCEEDS_SETTLEMENT/);
    await client.query('ROLLBACK');
  });
});

describe('structural rules', () => {
  it('requires a member to be either a real profile or a ghost', async () => {
    const { groupId } = await seedGroup(client, { memberCount: 1 });
    expect(
      await expectDenied(
        client.query(
          `INSERT INTO group_members (id, group_id, profile_id, ghost_name) VALUES ($1, $2, NULL, NULL)`,
          [randomUUID(), groupId],
        ),
      ),
    ).toMatch(/profile_xor_ghost/);
  });

  it('advances the per-group sync cursor on every change (TDR §4)', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const before = big(
      (await client.query(`SELECT updated_seq FROM groups WHERE id = $1`, [groupId])).rows[0]
        ?.updated_seq,
    );
    await addEqualSplitExpense(client, {
      groupId,
      amount: 500n,
      payers: { [memberIds[0] as string]: 500n },
      participants: memberIds.slice(0, 2) as string[],
    });
    const after = big(
      (await client.query(`SELECT updated_seq FROM groups WHERE id = $1`, [groupId])).rows[0]
        ?.updated_seq,
    );
    expect(after > before).toBe(true);
  });
});
