/**
 * Integrity: an attachment / settlement proof may only point at bytes that were
 * really uploaded (20260825240000). The attach RPCs require a committed
 * `storage_objects` row at the key — a phantom, pending-only, or wrong-bucket
 * path is refused at the SECURITY DEFINER boundary (ADR-013), so a client that
 * ignores the happy-path upload still cannot record a broken pointer.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import {
  addEqualSplitExpense,
  connect,
  expectDenied,
  seedCommittedObject,
  seedGroup,
} from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function as<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query(`SET ROLE authenticated`);
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
  }
}

async function makeSettlement(groupId: string, from: string, to: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method, status)
     VALUES ($1, $2, $3, $4, 'INR', 1000, 'upi', 'initiated')`,
    [id, groupId, from, to],
  );
  return id;
}

// m0 = author + sole payer → the party; also the from-member of a settlement.
let g: { groupId: string; profileIds: string[]; memberIds: string[] };
let expenseId: string;
let settlementId: string;

beforeAll(async () => {
  g = await seedGroup(client, { memberCount: 2, name: 'CommitCheck' });
  ({ expenseId } = await addEqualSplitExpense(client, {
    groupId: g.groupId,
    payers: { [g.memberIds[0] as string]: 2000n },
    participants: g.memberIds,
    amount: 2000n,
  }));
  settlementId = await makeSettlement(
    g.groupId,
    g.memberIds[0] as string,
    g.memberIds[1] as string,
  );
});

const P = (i: number) => g.profileIds[i] as string;

beforeEach(async () => {
  await client.query(`DELETE FROM expense_attachments WHERE group_id = $1`, [g.groupId]);
  await client.query(`DELETE FROM settlement_proofs WHERE group_id = $1`, [g.groupId]);
});

const attachExpense = (path: string) =>
  as(P(0), () =>
    client.query(`SELECT waves_attach_expense_attachment($1, $2, 'group', NULL) AS id`, [
      expenseId,
      path,
    ]),
  );

const attachProof = (path: string) =>
  as(P(0), () =>
    client.query(`SELECT waves_attach_settlement_proof($1, $2, NULL) AS id`, [settlementId, path]),
  );

const countAttachments = () =>
  client
    .query(`SELECT count(*)::int AS n FROM expense_attachments WHERE expense_id = $1`, [expenseId])
    .then((r) => r.rows[0].n as number);

const countProofs = () =>
  client
    .query(`SELECT count(*)::int AS n FROM settlement_proofs WHERE settlement_id = $1`, [
      settlementId,
    ])
    .then((r) => r.rows[0].n as number);

describe('waves_attach_expense_attachment requires a committed object', () => {
  it('rejects a scoped path with no storage_objects row at all', async () => {
    const path = `${expenseId}/${randomUUID()}.webp`; // never uploaded
    const message = await expectDenied(attachExpense(path));
    expect(message).toMatch(/OBJECT_NOT_COMMITTED/);
    expect(await countAttachments()).toBe(0);
  });

  it('rejects a path that is only a pending reservation', async () => {
    const path = `${expenseId}/${randomUUID()}.webp`;
    await seedCommittedObject(client, {
      bucket: 'expense-attachments',
      path,
      ownerProfileId: P(0),
      pending: true, // reserved, never committed
    });
    const message = await expectDenied(attachExpense(path));
    expect(message).toMatch(/OBJECT_NOT_COMMITTED/);
    expect(await countAttachments()).toBe(0);
  });

  it('rejects a committed object that lives in a different logical bucket', async () => {
    const path = `${expenseId}/${randomUUID()}.webp`;
    // Committed, but under `receipts` — not the `expense-attachments` bucket.
    await seedCommittedObject(client, { bucket: 'receipts', path, ownerProfileId: P(0) });
    const message = await expectDenied(attachExpense(path));
    expect(message).toMatch(/OBJECT_NOT_COMMITTED/);
    expect(await countAttachments()).toBe(0);
  });

  it('accepts a committed object with the correct bucket and path', async () => {
    const path = `${expenseId}/${randomUUID()}.webp`;
    await seedCommittedObject(client, {
      bucket: 'expense-attachments',
      path,
      ownerProfileId: P(0),
    });
    await attachExpense(path);
    expect(await countAttachments()).toBe(1);
    const { rows } = await client.query(
      `SELECT storage_path FROM expense_attachments WHERE expense_id = $1`,
      [expenseId],
    );
    expect(rows[0].storage_path).toBe(path);
  });
});

describe('waves_attach_settlement_proof requires a committed object', () => {
  it('rejects a scoped path with no committed object', async () => {
    const path = `${settlementId}/${randomUUID()}.webp`;
    const message = await expectDenied(attachProof(path));
    expect(message).toMatch(/OBJECT_NOT_COMMITTED/);
    expect(await countProofs()).toBe(0);
  });

  it('rejects a pending-only reservation', async () => {
    const path = `${settlementId}/${randomUUID()}.webp`;
    await seedCommittedObject(client, {
      bucket: 'settlement-proofs',
      path,
      ownerProfileId: P(0),
      pending: true,
    });
    const message = await expectDenied(attachProof(path));
    expect(message).toMatch(/OBJECT_NOT_COMMITTED/);
    expect(await countProofs()).toBe(0);
  });

  it('accepts a committed object at the right key', async () => {
    const path = `${settlementId}/${randomUUID()}.webp`;
    await seedCommittedObject(client, {
      bucket: 'settlement-proofs',
      path,
      ownerProfileId: P(0),
    });
    await attachProof(path);
    expect(await countProofs()).toBe(1);
  });
});

describe('the committed-object guard is not a client-callable oracle', () => {
  it('a client cannot execute waves_require_committed_object directly', async () => {
    // Supabase grants EXECUTE on new public functions to anon/authenticated by
    // default; the migration must revoke it, or a client could probe whether any
    // (bucket, path) is committed in the service-role-only ledger.
    const message = await as(P(0), () =>
      expectDenied(
        client.query(`SELECT waves_require_committed_object('avatars', $1)`, [
          `${randomUUID()}/a.webp`,
        ]),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});
