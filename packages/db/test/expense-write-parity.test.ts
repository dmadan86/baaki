/**
 * Direct-write parity (the `expense-write` edge vs the `/sync` mutation).
 *
 * Both edge paths now call `waves_apply_expense` through one shared argument
 * builder (`buildApplyExpenseArgs` in @waves/core), so a create or edit carries
 * an identical set of fields whichever path it took. These tests exercise the
 * RPC the way both edges call it — with named arguments — to prove the two
 * fields the direct path used to drop are honoured end to end:
 *
 *   • `p_category_meta` — the denormalised custom-tag snapshot is stored on the
 *     version, on both a create and an edit (a new version).
 *   • `p_base_version_no` — a stale edit is superseded, the same conflict
 *     behaviour `/sync` has always had (TDR §4.4).
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, seedGroup } from './helpers.js';

let client: Client;

interface ApplyResult {
  expenseId: string;
  versionId: string;
  versionNo: number;
  replayed: boolean;
  superseded: boolean;
  supersededVersionNo: number | null;
}

/** Call `waves_apply_expense` with NAMED arguments — exactly the shape both
 *  edges send via `buildApplyExpenseArgs`, so field names, not positions, are
 *  what this asserts against. */
async function applyExpense(params: {
  groupId: string;
  author: string;
  amount: bigint;
  payers: { memberId: string; amount: string }[];
  shares: { memberId: string; amount: string }[];
  expenseId?: string | null;
  mutationId?: string | null;
  baseVersionNo?: number | null;
  description?: string;
  categoryMeta?: Record<string, unknown> | null;
}): Promise<ApplyResult> {
  const result = await client.query(
    `SELECT waves_apply_expense(
        p_group_id           := $1,
        p_expense_id         := $2,
        p_author_member_id   := $3,
        p_description        := $4,
        p_category           := $5,
        p_expense_date       := '2026-03-01',
        p_currency           := 'INR',
        p_amount             := $6,
        p_split_type         := 'equal',
        p_split_params       := '{"kind":"equal"}'::jsonb,
        p_payers             := $7::jsonb,
        p_shares             := $8::jsonb,
        p_client_mutation_id := $9,
        p_base_version_no    := $10,
        p_category_meta      := $11::jsonb
      ) AS out`,
    [
      params.groupId,
      params.expenseId ?? null,
      params.author,
      params.description ?? 'Dinner',
      params.categoryMeta ? 'custom-tag-id' : null,
      params.amount.toString(),
      JSON.stringify(params.payers),
      JSON.stringify(params.shares),
      params.mutationId ?? randomUUID(),
      params.baseVersionNo ?? null,
      params.categoryMeta ? JSON.stringify(params.categoryMeta) : null,
    ],
  );
  return result.rows[0]?.out as ApplyResult;
}

/** An even two-way split, all these tests need. */
const halves = (a: string, b: string, amount: bigint) => ({
  payers: [{ memberId: a, amount: amount.toString() }],
  shares: [
    { memberId: a, amount: (amount / 2n).toString() },
    { memberId: b, amount: (amount - amount / 2n).toString() },
  ],
});

/** Read the stored `category_meta` snapshot for one version of an expense. */
async function categoryMetaOfVersion(expenseId: string, versionNo: number): Promise<unknown> {
  const { rows } = await client.query(
    `SELECT category_meta FROM expense_versions WHERE expense_id = $1 AND version_no = $2`,
    [expenseId, versionNo],
  );
  return rows[0]?.category_meta ?? null;
}

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

describe('direct write preserves category_meta (parity with /sync)', () => {
  it('stores the custom-tag snapshot on a create', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const tag = { label: 'Chai', icon: 'cup', tint: 'peach' };

    const created = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      categoryMeta: tag,
      ...halves(a, b, 1000n),
    });

    expect(created.versionNo).toBe(1);
    expect(await categoryMetaOfVersion(created.expenseId, 1)).toEqual(tag);
  });

  it('keeps category_meta on an edit, and per-version', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];
    const first = { label: 'Chai', icon: 'cup', tint: 'peach' };
    const second = { label: 'Feast', icon: 'plate', tint: 'coral' };

    const created = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      categoryMeta: first,
      ...halves(a, b, 1000n),
    });

    const edited = await applyExpense({
      groupId,
      author: a,
      expenseId: created.expenseId,
      amount: 2000n,
      description: 'Edited',
      baseVersionNo: 1,
      categoryMeta: second,
      ...halves(a, b, 2000n),
    });

    expect(edited.versionNo).toBe(2);
    // The append-only history keeps each version's own snapshot (ADR-004).
    expect(await categoryMetaOfVersion(created.expenseId, 1)).toEqual(first);
    expect(await categoryMetaOfVersion(created.expenseId, 2)).toEqual(second);
  });
});

describe('direct stale edit is superseded (same as /sync, TDR §4.4)', () => {
  it('supersedes an edit based on an out-of-date version', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    const [a, b] = memberIds as [string, string];

    const created = await applyExpense({
      groupId,
      author: a,
      amount: 1000n,
      ...halves(a, b, 1000n),
    });
    expect(created.superseded).toBe(false);

    // First edit, correctly based on v1 — not a conflict.
    const fresh = await applyExpense({
      groupId,
      author: a,
      expenseId: created.expenseId,
      amount: 2000n,
      description: 'Fresh edit',
      baseVersionNo: 1,
      ...halves(a, b, 2000n),
    });
    expect(fresh.superseded).toBe(false);

    // Second edit ALSO based on the now-stale v1 — the direct path supplies
    // p_base_version_no just like /sync, so this is flagged, not silently
    // overwritten.
    const stale = await applyExpense({
      groupId,
      author: b,
      expenseId: created.expenseId,
      amount: 3000n,
      description: 'Stale edit',
      baseVersionNo: 1,
      ...halves(b, a, 3000n),
    });

    expect(stale.superseded).toBe(true);
    expect(stale.supersededVersionNo).toBe(fresh.versionNo);
  });
});
