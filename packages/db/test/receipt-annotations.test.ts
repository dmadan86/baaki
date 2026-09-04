/**
 * Receipt markup (A46): only a party to the expense may set or clear the pen/text
 * overlay on an attachment, and the column bounds how large it can be.
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

// m0 = author + sole payer → the only PARTY. m1 = a member but non-party.
let g: { groupId: string; profileIds: string[]; memberIds: string[] };
let expenseId: string;
let attachmentId: string;
let outsider: string;

beforeAll(async () => {
  g = await seedGroup(client, { memberCount: 3, name: 'Markup' });
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
  // A fresh group-visible attachment owned by the party each test. The attach
  // RPC now requires a committed object at the key, so seed one first.
  attachmentId = randomUUID();
  const path = `${expenseId}/${randomUUID()}.webp`;
  await seedCommittedObject(client, {
    bucket: 'expense-attachments',
    path,
    ownerProfileId: P(0),
  });
  await as(P(0), () =>
    client.query(`SELECT waves_attach_expense_attachment($1, $2, 'group', $3)`, [
      expenseId,
      path,
      attachmentId,
    ]),
  );
});

const annotate = (profileId: string, id: string, annotations: unknown) =>
  as(profileId, () =>
    client.query(`SELECT waves_annotate_expense_attachment($1, $2::jsonb)`, [
      id,
      annotations === null ? null : JSON.stringify(annotations),
    ]),
  );

const readAnnotations = (id: string) =>
  client
    .query(`SELECT annotations FROM expense_attachments WHERE id = $1`, [id])
    .then((r) => r.rows[0]?.annotations ?? null);

const sample = {
  strokes: [{ color: '#EF4444', width: 0.01, points: [0.1, 0.2, 0.3, 0.4] }],
  texts: [],
};

describe('receipt annotations', () => {
  it('a party sets the markup', async () => {
    await annotate(P(0), attachmentId, sample);
    expect(await readAnnotations(attachmentId)).toMatchObject(sample);
  });

  it('a party clears the markup with null', async () => {
    await annotate(P(0), attachmentId, sample);
    await annotate(P(0), attachmentId, null);
    expect(await readAnnotations(attachmentId)).toBeNull();
  });

  it('a non-party member cannot mark up', async () => {
    await expectDenied(annotate(P(1), attachmentId, sample));
    expect(await readAnnotations(attachmentId)).toBeNull();
  });

  it('an outsider cannot mark up', async () => {
    await expectDenied(annotate(outsider, attachmentId, sample));
  });

  it('an unknown attachment id is a silent no-op, not an error', async () => {
    await annotate(P(0), randomUUID(), sample); // resolves, changes nothing
  });

  it('rejects an oversized overlay (column cap)', async () => {
    const huge = {
      strokes: [
        { color: '#EF4444', width: 0.01, points: Array.from({ length: 200000 }, () => 0.5) },
      ],
      texts: [],
    };
    await expectDenied(annotate(P(0), attachmentId, huge));
  });
});
