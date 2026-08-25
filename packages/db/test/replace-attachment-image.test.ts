/**
 * Adjust (rotate/crop) a receipt image (A46): only a party may repoint an
 * attachment at new bytes, the key must stay scoped to the expense, and the
 * replace clears any markup (the pixels moved).
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, connect, expectDenied, seedGroup } from './helpers';

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
  await as(P(0), () =>
    client.query(`SELECT baaki_attach_expense_attachment($1, $2, 'group', $3)`, [
      expenseId,
      `${expenseId}/${randomUUID()}.webp`,
      attachmentId,
    ]),
  );
  // Give it markup so we can prove the replace clears it.
  await as(P(0), () =>
    client.query(`SELECT baaki_annotate_expense_attachment($1, $2::jsonb)`, [
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
    client.query(`SELECT baaki_replace_expense_attachment_image($1, $2)`, [id, path]),
  );

const row = (id: string) =>
  client
    .query(`SELECT storage_path, annotations FROM expense_attachments WHERE id = $1`, [id])
    .then((r) => r.rows[0]);

describe('replace attachment image', () => {
  it('a party repoints the row and the markup is cleared', async () => {
    const newPath = `${expenseId}/${randomUUID()}.webp`;
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

  // TODO(integrity): the RPC only checks that the new path is scoped to the
  // expense (`<expenseId>/…`) — it never checks that a committed row for that
  // path exists in `storage_objects`. A party can repoint an attachment at
  // bytes that were never uploaded (a typo'd path, a path from a different
  // logical bucket, or one that was only ever `pending`/released and never
  // committed), and the RPC clears the markup and succeeds anyway, leaving the
  // row pointing at nothing. This matches the sibling
  // `baaki_attach_expense_attachment` (20260824150000 / 20260825130000), which
  // has the exact same gap — it is not unique to replace, so this is
  // documented rather than fixed here: fixing one without the other would be
  // an inconsistent half-measure, and fixing both is a wider change (every
  // other DB test that attaches with a made-up path — expense-image-events,
  // receipt-annotations — would need a real `storage_objects` row too).
  it('TODO(integrity): a syntactically valid but never-committed path is accepted', async () => {
    // Scoped correctly, never went through r2-sign's `put`/`commit` — no row
    // for it in storage_objects.
    const neverUploaded = `${expenseId}/${randomUUID()}.webp`;
    const orphaned = await client
      .query(`SELECT count(*)::int AS n FROM storage_objects WHERE path = $1`, [neverUploaded])
      .then((r) => r.rows[0].n as number);
    expect(orphaned).toBe(0);

    await replace(P(0), attachmentId, neverUploaded);

    const r = await row(attachmentId);
    expect(r.storage_path).toBe(neverUploaded);
    expect(r.annotations).toBeNull();
  });
});
