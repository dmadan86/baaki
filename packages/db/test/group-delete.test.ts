/**
 * Deleting a group, Splitwise-style (A49).
 *
 * An admin can drop a group for everyone, but only once it is fully settled —
 * and ADR-004 keeps the ledger append-only, so a delete is a group-wide
 * tombstone (`groups.deleted_at`), never a row delete. These pin the boundary
 * `baaki_delete_group` enforces, which the client button only fronts: an admin
 * of a squared-up group deletes; a non-admin is refused (NOT_ADMIN); an
 * outstanding balance is refused (NOT_SETTLED); a second delete is a clean no-op.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, connect, expectDenied, seedGroup } from './helpers.js';

let client: Client;

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

async function deletedAt(groupId: string): Promise<string | null> {
  const { rows } = await client.query(`SELECT deleted_at FROM groups WHERE id = $1`, [groupId]);
  // pg hands back a Date for timestamptz; normalise to an ISO string so two
  // reads of the same instant compare equal (not two distinct Date objects).
  const value = (rows[0]?.deleted_at as Date | string | null) ?? null;
  return value === null ? null : new Date(value).toISOString();
}

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

describe('deleting a group', () => {
  it('lets an admin delete a fully-settled group, as a tombstone', async () => {
    // Two members with an expense that nets to zero — each pays exactly their own
    // share — so the group is square. Deleting it stamps `deleted_at` and leaves
    // every row in place (ADR-004).
    const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 2 });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 1000n,
      participants: [memberIds[0]!, memberIds[1]!],
      payers: { [memberIds[0]!]: 500n, [memberIds[1]!]: 500n },
    });

    await asUser(profileIds[0]!, () => client.query(`SELECT baaki_delete_group($1)`, [groupId]));

    expect(await deletedAt(groupId)).not.toBeNull();
    // The group row (and its expense) are still there — a tombstone hides it, it
    // is not erased.
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM expenses WHERE group_id = $1`,
      [groupId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('refuses a non-admin member (NOT_ADMIN)', async () => {
    const { groupId, profileIds } = await seedGroup(client, { memberCount: 2 });

    // profileIds[1] is an ordinary member, not an admin.
    const message = await asUser(profileIds[1]!, () =>
      expectDenied(client.query(`SELECT baaki_delete_group($1)`, [groupId])),
    );
    expect(message).toMatch(/NOT_ADMIN/);
    expect(await deletedAt(groupId)).toBeNull();
  });

  it('refuses a group with an outstanding balance (NOT_SETTLED)', async () => {
    // One member paid the whole bill; the other owes their share — the group is
    // not square, so even the admin cannot delete it.
    const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 2 });
    await addEqualSplitExpense(client, {
      groupId,
      amount: 1000n,
      participants: [memberIds[0]!, memberIds[1]!],
      payers: { [memberIds[0]!]: 1000n },
    });

    const message = await asUser(profileIds[0]!, () =>
      expectDenied(client.query(`SELECT baaki_delete_group($1)`, [groupId])),
    );
    expect(message).toMatch(/NOT_SETTLED/);
    expect(await deletedAt(groupId)).toBeNull();
  });

  it('is idempotent — a second delete is a clean no-op', async () => {
    const { groupId, profileIds } = await seedGroup(client, { memberCount: 2 });

    await asUser(profileIds[0]!, () => client.query(`SELECT baaki_delete_group($1)`, [groupId]));
    const first = await deletedAt(groupId);
    expect(first).not.toBeNull();

    // A retried queue flush or a second tap must land cleanly, not raise, and not
    // move the tombstone's timestamp.
    await asUser(profileIds[0]!, () => client.query(`SELECT baaki_delete_group($1)`, [groupId]));
    expect(await deletedAt(groupId)).toBe(first);
  });
});
