/**
 * Adjust (rotate/crop) a receipt image (A46): only a party may repoint an
 * attachment at new bytes, the key must stay scoped to the expense, and the
 * replace clears any markup (the pixels moved).
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

async function as<T>(profileId: string | null, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    profileId
      ? JSON.stringify({ sub: profileId, role: 'authenticated' })
      : JSON.stringify({ role: 'anon' }),
  ]);
  await client.query(`SET ROLE ${profileId ? 'authenticated' : 'anon'}`);
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
  }
}

let g: { groupId: string; profileIds: string[]; memberIds: string[] };
let expenseId: string;
let attachmentId: string;
let outsider: string;

beforeAll(async () => {
  g = await seedGroup(client, { memberCount: 3, name: 'Adjust' });
  outsider = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Outsider', 'INR')`,
    [outsider],
  );
  ({ expenseId } = await addEqualSplitExpense(client, {
    groupId: g.groupId,
    payers: { [g.memberIds[0] as string]: 3000n },
    participants: g.memberIds,
    amount: 3000n,
  }));
});

const P = (i: number) => g.profileIds[i] as string;

beforeEach(async () => {
  await client.query(`DELETE FROM expense_attachments WHERE group_id = $1`, [g.groupId]);
  attachmentId = randomUUID();
  const initialPath = `${expenseId}/${randomUUID()}.webp`;
  // The attach RPC now requires a committed object at the key; the real client
  // uploads (put + commit) before attaching, so seed that committed row.
  await seedCommittedObject(client, {
    bucket: 'expense-attachments',
    path: initialPath,
    ownerProfileId: P(0),
  });
  await as(P(0), () =>
    client.query(`SELECT waves_attach_expense_attachment($1, $2, 'group', $3)`, [
      expenseId,
      initialPath,
      attachmentId,
    ]),
  );
  // Give it markup so we can prove the replace clears it.
  await as(P(0), () =>
    client.query(`SELECT waves_annotate_expense_attachment($1, $2::jsonb)`, [
      attachmentId,
      JSON.stringify({
        strokes: [{ color: '#EF4444', width: 0.01, points: [0.1, 0.2] }],
        texts: [],
      }),
    ]),
  );
});

const replace = (profileId: string, id: string, path: string) =>
  as(profileId, () =>
    client.query(`SELECT waves_replace_expense_attachment_image($1, $2)`, [id, path]),
  );

const row = (id: string) =>
  client
    .query(`SELECT storage_path, annotations FROM expense_attachments WHERE id = $1`, [id])
    .then((r) => r.rows[0]);

describe('replace attachment image', () => {
  it('a party repoints the row and the markup is cleared', async () => {
    const newPath = `${expenseId}/${randomUUID()}.webp`;
    // The rotate/crop bytes were uploaded to the fresh key first.
    await seedCommittedObject(client, {
      bucket: 'expense-attachments',
      path: newPath,
      ownerProfileId: P(0),
    });
    await replace(P(0), attachmentId, newPath);
    const r = await row(attachmentId);
    expect(r.storage_path).toBe(newPath);
    expect(r.annotations).toBeNull();
  });

  it('a non-party member cannot replace', async () => {
    await expectDenied(replace(P(1), attachmentId, `${expenseId}/${randomUUID()}.webp`));
  });

  it('an outsider cannot replace', async () => {
    await expectDenied(replace(outsider, attachmentId, `${expenseId}/${randomUUID()}.webp`));
  });

  it('rejects a key not scoped to the expense', async () => {
    await expectDenied(replace(P(0), attachmentId, `${randomUUID()}/evil.webp`));
  });

  it('an unknown attachment id is a silent no-op', async () => {
    await replace(P(0), randomUUID(), `${expenseId}/${randomUUID()}.webp`);
  });

  // Integrity (20260825240000): the RPC now checks that a committed object for
  // the new path exists in `storage_objects`. A party can no longer repoint an
  // attachment at bytes that were never uploaded (a typo'd path, a path from a
  // different logical bucket, or one that was only ever `pending`/released and
  // never committed) — the row can never end up pointing at nothing.
  it('rejects a syntactically valid but never-committed path, and leaves the row untouched', async () => {
    // Scoped correctly, never went through r2-sign's `put`/`commit` — no row
    // for it in storage_objects.
    const neverUploaded = `${expenseId}/${randomUUID()}.webp`;
    const orphaned = await client
      .query(`SELECT count(*)::int AS n FROM storage_objects WHERE path = $1`, [neverUploaded])
      .then((r) => r.rows[0].n as number);
    expect(orphaned).toBe(0);

    const before = await row(attachmentId);
    const message = await expectDenied(replace(P(0), attachmentId, neverUploaded));
    expect(message).toMatch(/OBJECT_NOT_COMMITTED/);

    // The row is unchanged: still the old path, and the failed replace did NOT
    // clear the markup.
    const after = await row(attachmentId);
    expect(after.storage_path).toBe(before.storage_path);
    expect(after.annotations).not.toBeNull();
  });

  it('rejects a path that is only a pending reservation (uploaded but never committed)', async () => {
    const reservedOnly = `${expenseId}/${randomUUID()}.webp`;
    await seedCommittedObject(client, {
      bucket: 'expense-attachments',
      path: reservedOnly,
      ownerProfileId: P(0),
      pending: true,
    });
    const message = await expectDenied(replace(P(0), attachmentId, reservedOnly));
    expect(message).toMatch(/OBJECT_NOT_COMMITTED/);
  });

  it('rejects a committed object that lives in the wrong logical bucket', async () => {
    const wrongBucket = `${expenseId}/${randomUUID()}.webp`;
    // Committed, but under `receipts`, not `expense-attachments`.
    await seedCommittedObject(client, {
      bucket: 'receipts',
      path: wrongBucket,
      ownerProfileId: P(0),
    });
    const message = await expectDenied(replace(P(0), attachmentId, wrongBucket));
    expect(message).toMatch(/OBJECT_NOT_COMMITTED/);
  });
});
