/**
 * The expense image audit (A46 part 2) — the append-only trail of who added or
 * removed a receipt or an attachment. Two properties matter and are tested here:
 *
 *   1. A line is unforgeable and membership-gated: the actor is the session's,
 *      an outsider cannot write one, and the receipt door only writes receipts.
 *   2. A `parties` line inherits the attachment's visibility — a non-party
 *      member of the group never sees that a private attachment existed.
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

// m0 = admin, author and sole payer → the only PARTY. m1 & m2 are members but
// non-parties. An outsider profile in no group.
let g: { groupId: string; profileIds: string[]; memberIds: string[] };
let expenseId: string;
let outsider: string;

beforeAll(async () => {
  g = await seedGroup(client, { memberCount: 3, name: 'ImageAudit' });
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

beforeEach(async () => {
  await client.query(`DELETE FROM expense_image_events WHERE group_id = $1`, [g.groupId]);
  await client.query(`DELETE FROM expense_attachments WHERE group_id = $1`, [g.groupId]);
});

const P = (i: number) => g.profileIds[i] as string;
const M = (i: number) => g.memberIds[i] as string;

const logReceipt = (profileId: string, action: string, id = randomUUID()) =>
  as(profileId, () =>
    client.query(`SELECT baaki_log_receipt_event($1, $2, $3, $4)`, [
      id,
      g.groupId,
      expenseId,
      action,
    ]),
  );

const attach = (profileId: string, visibility: string, id = randomUUID()) =>
  as(profileId, () =>
    client
      .query(`SELECT baaki_attach_expense_attachment($1, $2, $3, $4) AS id`, [
        expenseId,
        `${expenseId}/${randomUUID()}.webp`,
        visibility,
        id,
      ])
      .then((r) => r.rows[0].id as string),
  );

const remove = (profileId: string, attachmentId: string) =>
  as(profileId, () => client.query(`SELECT baaki_remove_expense_attachment($1)`, [attachmentId]));

/** The events on this expense that `profileId` may see (RLS applied). */
const eventsVisibleTo = (profileId: string | null) =>
  as(profileId, () =>
    client
      .query(
        `SELECT kind, action, visibility, actor_member_id
           FROM expense_image_events WHERE expense_id = $1 ORDER BY created_at`,
        [expenseId],
      )
      .then((r) => r.rows),
  );

describe('receipt audit line', () => {
  it('a member records an add, stamped with their own member id', async () => {
    await logReceipt(P(0), 'added');
    const rows = await eventsVisibleTo(P(0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'receipt',
      action: 'added',
      visibility: 'group',
      actor_member_id: M(0),
    });
  });

  it('is group-visible — every member sees a receipt line', async () => {
    await logReceipt(P(0), 'added');
    expect(await eventsVisibleTo(P(1))).toHaveLength(1);
    expect(await eventsVisibleTo(P(2))).toHaveLength(1);
  });

  it('is idempotent on the event id — a retry writes no second line', async () => {
    const id = randomUUID();
    await logReceipt(P(0), 'added', id);
    await logReceipt(P(0), 'added', id);
    expect(await eventsVisibleTo(P(0))).toHaveLength(1);
  });

  it('rejects an action that is not added/removed', async () => {
    await expectDenied(logReceipt(P(0), 'edited'));
  });

  it('rejects an expense that is not in the named group', async () => {
    const otherExpense = randomUUID();
    await expectDenied(
      as(P(0), () =>
        client.query(`SELECT baaki_log_receipt_event($1, $2, $3, 'added')`, [
          randomUUID(),
          g.groupId,
          otherExpense,
        ]),
      ),
    );
  });

  it('an outsider (no membership) cannot write a line', async () => {
    await expectDenied(logReceipt(outsider, 'added'));
  });

  it('the receipt door cannot be used to fabricate an attachment line', async () => {
    // Only four positional args exist and kind is hard-coded to 'receipt'; there
    // is no parameter that could make this an 'attachment' or a 'parties' row.
    await logReceipt(P(0), 'added');
    const rows = await eventsVisibleTo(P(0));
    expect(rows.every((r) => r.kind === 'receipt' && r.visibility === 'group')).toBe(true);
  });
});

describe('attachment audit line, emitted by the attach/remove RPCs', () => {
  it('a group attachment emits a group-visible added line', async () => {
    await attach(P(0), 'group');
    const rows = await eventsVisibleTo(P(0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'attachment', action: 'added', visibility: 'group' });
    // A non-party member still sees a group line.
    expect(await eventsVisibleTo(P(1))).toHaveLength(1);
  });

  it('a parties attachment emits a line only its parties can see', async () => {
    await attach(P(0), 'parties');
    // The party (author + payer) sees it.
    const partyRows = await eventsVisibleTo(P(0));
    expect(partyRows).toHaveLength(1);
    expect(partyRows[0]).toMatchObject({ visibility: 'parties' });
    // A non-party member of the same group does NOT — the line would otherwise
    // leak that a private attachment ever existed.
    expect(await eventsVisibleTo(P(1))).toHaveLength(0);
    expect(await eventsVisibleTo(P(2))).toHaveLength(0);
  });

  it('a removal emits one removed line, carrying the attachment visibility', async () => {
    const id = await attach(P(0), 'parties');
    await remove(P(0), id);
    const rows = await eventsVisibleTo(P(0));
    expect(rows.map((r) => r.action)).toEqual(['added', 'removed']);
    expect(rows[1]).toMatchObject({ visibility: 'parties' });
    // The removed line is party-only too.
    expect(await eventsVisibleTo(P(1))).toHaveLength(0);
  });

  it('a repeated removal does not stutter the trail', async () => {
    const id = await attach(P(0), 'group');
    await remove(P(0), id);
    await remove(P(0), id);
    const rows = await eventsVisibleTo(P(0));
    expect(rows.filter((r) => r.action === 'removed')).toHaveLength(1);
  });

  it('an idempotent re-attach (same id) does not double the added line', async () => {
    const id = randomUUID();
    await attach(P(0), 'group', id);
    await attach(P(0), 'group', id);
    const rows = await eventsVisibleTo(P(0));
    expect(rows.filter((r) => r.action === 'added')).toHaveLength(1);
  });
});

describe('anon', () => {
  it('sees no events and cannot log one', async () => {
    await logReceipt(P(0), 'added');
    expect(await eventsVisibleTo(null)).toHaveLength(0);
    await expectDenied(
      as(null, () =>
        client.query(`SELECT baaki_log_receipt_event($1, $2, $3, 'added')`, [
          randomUUID(),
          g.groupId,
          expenseId,
        ]),
      ),
    );
  });
});
