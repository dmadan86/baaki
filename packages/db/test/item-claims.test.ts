/**
 * Four people claiming lines off one receipt at the same time.
 *
 * This is the M5 acceptance clause that has been outstanding since the
 * milestone shipped — not because it was hard, but because the feature it
 * describes was never built. `receipt_item_claims` existed with policies and a
 * unique constraint and nothing in the app ever wrote to it.
 *
 * Four real connections, not four sequential calls on one. A test that awaits
 * each write in turn proves the writes work; it proves nothing about what
 * happens when they overlap, which is the only interesting question here.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import {
  addEqualSplitExpense,
  CONNECTION_STRING,
  connect,
  expectDenied,
  seedGroup,
  type SeededGroup,
} from './helpers';

let admin: Client;
let group: SeededGroup;
let receiptId: string;

/** One connection per person, because that is what four phones are. */
const clients: Client[] = [];

beforeAll(async () => {
  admin = await connect();
  group = await seedGroup(admin, { memberCount: 4, name: 'Biryani night' });

  receiptId = randomUUID();
  await admin.query(
    `INSERT INTO receipts (id, group_id, created_by, storage_path, source, parse_status)
     VALUES ($1, $2, $3, 'receipts/x.jpg', 'camera', 'parsed')`,
    [receiptId, group.groupId, group.memberIds[0]],
  );

  for (const profileId of group.profileIds) {
    const client = new Client({ connectionString: CONNECTION_STRING });
    await client.connect();
    await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: profileId, role: 'authenticated' }),
    ]);
    await client.query('SET ROLE authenticated');
    clients.push(client);
  }
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end()));
  await admin.end();
});

beforeEach(async () => {
  await admin.query(`DELETE FROM receipt_item_claims WHERE receipt_id = $1`, [receiptId]);
});

const claim = (who: number, item: number, claimed = true) =>
  clients[who]!.query(`SELECT baaki_set_item_claim($1, $2, $3) AS r`, [receiptId, item, claimed]);

async function liveClaims(): Promise<{ item: number; member: string }[]> {
  const { rows } = await admin.query(
    `SELECT item_index, member_id FROM receipt_item_claims
      WHERE receipt_id = $1 AND released_at IS NULL
      ORDER BY item_index, member_id`,
    [receiptId],
  );
  return rows.map((row) => ({ item: Number(row.item_index), member: String(row.member_id) }));
}

describe('four people, one receipt, at the same time', () => {
  it('keeps every claim when four claim four different lines at once', async () => {
    // The ordinary case round a table, and the one that must never lose a row.
    await Promise.all([claim(0, 0), claim(1, 1), claim(2, 2), claim(3, 3)]);

    const claims = await liveClaims();
    expect(claims).toHaveLength(4);
    expect(claims.map((entry) => entry.item)).toEqual([0, 1, 2, 3]);
  });

  it('keeps every claim when all four claim the same line at once', async () => {
    // Four people sharing one biryani is not a conflict, it is four facts. A
    // last-writer-wins register here would keep one of them and lose three.
    await Promise.all([claim(0, 0), claim(1, 0), claim(2, 0), claim(3, 0)]);

    const claims = await liveClaims();
    expect(claims).toHaveLength(4);
    expect(new Set(claims.map((entry) => entry.member)).size).toBe(4);
  });

  it('survives the same person claiming the same line four times over', async () => {
    // A flaky tap, or a queue replayed after a reconnection.
    await Promise.all([claim(0, 5), claim(0, 5), claim(0, 5), claim(0, 5)]);
    expect(await liveClaims()).toHaveLength(1);
  });

  it('converges when everybody claims and releases the same line at once', async () => {
    // The stress case. Whatever order these land in, all four connections must
    // agree afterwards — and they must agree on rows, not on an error.
    await Promise.all([
      claim(0, 1, true),
      claim(1, 1, true),
      claim(0, 1, false),
      claim(2, 1, true),
      claim(1, 1, false),
      claim(3, 1, true),
    ]);

    const seen = await Promise.all(
      clients.map(async (client) => {
        const { rows } = await client.query(
          `SELECT item_index, member_id FROM baaki_item_claims($1) ORDER BY item_index, member_id`,
          [receiptId],
        );
        return JSON.stringify(rows);
      }),
    );
    // Every device sees the same set — that is the whole promise.
    expect(new Set(seen).size).toBe(1);
  });

  it('lets a claim win over a release that raced it', async () => {
    // Add-wins, deliberately: a claim that should have gone costs one more tap,
    // and a claim that vanished takes somebody's dinner off their bill and puts
    // it on everybody else's.
    await claim(0, 2, true);
    await claim(0, 2, false);
    await claim(0, 2, true);
    expect(await liveClaims()).toEqual([{ item: 2, member: group.memberIds[0] }]);
  });

  it('remembers a release instead of forgetting the claim ever happened', async () => {
    // The row stays as a tombstone, which is what lets a device that has been
    // offline tell "never claimed" from "claimed, then let go".
    await claim(0, 3, true);
    await claim(0, 3, false);

    expect(await liveClaims()).toEqual([]);
    const { rows } = await admin.query(
      `SELECT released_at, revision FROM receipt_item_claims
        WHERE receipt_id = $1 AND item_index = 3`,
      [receiptId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].released_at).not.toBeNull();
    expect(rows[0].revision).toBe(2);
  });
});

describe('a claim is always about the person making it', () => {
  it('does not let anybody claim on somebody else’s behalf', async () => {
    // `member_id` is resolved server-side and is not an argument, so there is
    // nothing to forge — the same rule as `actor_member_id` on the activity log.
    await claim(1, 7, true);
    expect(await liveClaims()).toEqual([{ item: 7, member: group.memberIds[1] }]);
  });

  it('refuses somebody who is not in the group', async () => {
    const outsider = randomUUID();
    await admin.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Mallory', 'INR')`,
      [outsider],
    );
    const stranger = new Client({ connectionString: CONNECTION_STRING });
    await stranger.connect();
    try {
      await stranger.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
        JSON.stringify({ sub: outsider, role: 'authenticated' }),
      ]);
      await stranger.query('SET ROLE authenticated');
      const message = await expectDenied(
        stranger.query(`SELECT baaki_set_item_claim($1, 0, true)`, [receiptId]),
      );
      expect(message).toMatch(/NOT_A_MEMBER/);
    } finally {
      await stranger.end();
    }
  });

  it('closes the direct write that used to bypass all of this', async () => {
    // The M4 policies let a client INSERT a claim naming any member, and DELETE
    // one — which is what made the set unable to converge in the first place.
    const message = await expectDenied(
      clients[0]!.query(
        `INSERT INTO receipt_item_claims (receipt_id, item_index, member_id)
         VALUES ($1, 9, $2)`,
        [receiptId, group.memberIds[2]],
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('refuses a receipt that does not exist', async () => {
    const message = await expectDenied(
      clients[0]!.query(`SELECT baaki_set_item_claim($1, 0, true)`, [randomUUID()]),
    );
    expect(message).toMatch(/NOT_FOUND/);
  });
});

describe('claiming for the friend who is not on Baaki', () => {
  let ghostId: string;

  beforeAll(async () => {
    ghostId = randomUUID();
    await admin.query(
      `INSERT INTO group_members (id, group_id, ghost_name, joined_via)
       VALUES ($1, $2, 'Ravi', 'ghost')`,
      [ghostId, group.groupId],
    );
  });

  it('lets anybody in the group tap for a ghost, because nobody else can', async () => {
    // A ghost is a name and nothing else — no profile, no phone, no way to
    // claim a line. Refusing on their behalf would mean the bill can never be
    // finished, which is a worse answer than the small forgery risk.
    await clients[1]!.query(`SELECT baaki_set_item_claim($1, 4, true, $2)`, [receiptId, ghostId]);
    expect(await liveClaims()).toEqual([{ item: 4, member: ghostId }]);
  });

  it('releases a ghost’s claim the same way', async () => {
    await clients[1]!.query(`SELECT baaki_set_item_claim($1, 4, true, $2)`, [receiptId, ghostId]);
    await clients[2]!.query(`SELECT baaki_set_item_claim($1, 4, false, $2)`, [receiptId, ghostId]);
    expect(await liveClaims()).toEqual([]);
  });

  it('still refuses to claim for somebody who has the app', async () => {
    // This is the whole point of the CRDT: a set of facts each owned by the
    // person who added it. One phone claiming for another turns it back into
    // one person's opinion.
    const message = await expectDenied(
      clients[0]!.query(`SELECT baaki_set_item_claim($1, 5, true, $2)`, [
        receiptId,
        group.memberIds[1],
      ]),
    );
    expect(message).toMatch(/NOT_YOURS/);
  });

  it('refuses a member id from another group entirely', async () => {
    const other = await seedGroup(admin, { memberCount: 1, ghostCount: 1, name: 'Elsewhere' });
    const message = await expectDenied(
      clients[0]!.query(`SELECT baaki_set_item_claim($1, 6, true, $2)`, [
        receiptId,
        other.memberIds[1],
      ]),
    );
    expect(message).toMatch(/UNKNOWN_MEMBER/);
  });
});

describe('finding the bill somebody else scanned', () => {
  beforeEach(async () => {
    await admin.query(`DELETE FROM receipt_item_claims WHERE receipt_id = $1`, [receiptId]);
    await admin.query(`UPDATE receipts SET parsed = $2 WHERE id = $1`, [
      receiptId,
      JSON.stringify({
        merchant: 'Anjappar',
        items: [
          { label: 'Biryani', total: 32000 },
          { label: 'Naan', total: 6000 },
        ],
        taxes: [],
        tip: null,
      }),
    ]);
  });

  it('lists a scanned bill nobody has split yet, with how far along it is', async () => {
    // Without this the second person at the table has no way to reach the bill
    // the first person scanned, and the whole CRDT is plumbing with no tap.
    await clients[0]!.query(`SELECT baaki_set_item_claim($1, 0, true)`, [receiptId]);
    await clients[1]!.query(`SELECT baaki_set_item_claim($1, 0, true)`, [receiptId]);

    const { rows } = await clients[2]!.query(
      `SELECT id, claimed, items FROM baaki_open_receipts($1)`,
      [group.groupId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(receiptId);
    // Two people on one line is one line claimed, not two.
    expect(rows[0].claimed).toBe(1);
    expect(rows[0].items).toBe(2);
  });

  it('drops it from the list once it has become an expense', async () => {
    const { rows: before } = await clients[0]!.query(`SELECT id FROM baaki_open_receipts($1)`, [
      group.groupId,
    ]);
    expect(before).toHaveLength(1);

    await addEqualSplitExpense(admin, {
      groupId: group.groupId,
      payers: { [group.memberIds[0]!]: 38000n },
      participants: [group.memberIds[0]!, group.memberIds[1]!],
      amount: 38000n,
      description: 'Anjappar',
      receiptId,
    });

    const { rows: after } = await clients[0]!.query(`SELECT id FROM baaki_open_receipts($1)`, [
      group.groupId,
    ]);
    expect(after).toHaveLength(0);
  });

  it('shows a stranger nothing', async () => {
    const other = await seedGroup(admin, { memberCount: 1, name: 'Elsewhere' });
    const { rows } = await clients[0]!.query(`SELECT id FROM baaki_open_receipts($1)`, [
      other.groupId,
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe('publishing the corrected lines', () => {
  const lines = JSON.stringify([
    { label: 'Biryani', total: 32000 },
    { label: 'Naan', total: 6000 },
  ]);

  beforeEach(async () => {
    await admin.query(`DELETE FROM receipt_item_claims WHERE receipt_id = $1`, [receiptId]);
    await admin.query(`UPDATE receipts SET parsed = NULL WHERE id = $1`, [receiptId]);
  });

  it('lets a member hand the lines to everybody else', async () => {
    await clients[0]!.query(`SELECT baaki_publish_receipt_items($1, $2::jsonb)`, [
      receiptId,
      lines,
    ]);
    const { rows } = await clients[2]!.query(
      `SELECT jsonb_array_length(parsed -> 'items') AS n FROM receipts WHERE id = $1`,
      [receiptId],
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it('refuses once somebody has started claiming', async () => {
    // A claim is stored against a line's index. Deleting the second of six
    // lines afterwards would move four people's dinners onto somebody else.
    await clients[0]!.query(`SELECT baaki_publish_receipt_items($1, $2::jsonb)`, [
      receiptId,
      lines,
    ]);
    await clients[1]!.query(`SELECT baaki_set_item_claim($1, 0, true)`, [receiptId]);

    const message = await expectDenied(
      clients[0]!.query(
        `SELECT baaki_publish_receipt_items($1, '[{"label":"x","total":1}]'::jsonb)`,
        [receiptId],
      ),
    );
    expect(message).toMatch(/ALREADY_CLAIMING/);
  });

  it('refuses a released claim too, because the index still means something', async () => {
    await clients[0]!.query(`SELECT baaki_publish_receipt_items($1, $2::jsonb)`, [
      receiptId,
      lines,
    ]);
    await clients[1]!.query(`SELECT baaki_set_item_claim($1, 0, true)`, [receiptId]);
    await clients[1]!.query(`SELECT baaki_set_item_claim($1, 0, false)`, [receiptId]);

    const message = await expectDenied(
      clients[0]!.query(`SELECT baaki_publish_receipt_items($1, $2::jsonb)`, [receiptId, lines]),
    );
    expect(message).toMatch(/ALREADY_CLAIMING/);
  });

  it('refuses an empty bill', async () => {
    const message = await expectDenied(
      clients[0]!.query(`SELECT baaki_publish_receipt_items($1, '[]'::jsonb)`, [receiptId]),
    );
    expect(message).toMatch(/INVALID_ITEMS/);
  });

  it('refuses somebody outside the group', async () => {
    const outsider = randomUUID();
    await admin.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Mallory', 'INR')`,
      [outsider],
    );
    const stranger = new Client({ connectionString: CONNECTION_STRING });
    await stranger.connect();
    try {
      await stranger.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
        JSON.stringify({ sub: outsider, role: 'authenticated' }),
      ]);
      await stranger.query('SET ROLE authenticated');
      const message = await expectDenied(
        stranger.query(`SELECT baaki_publish_receipt_items($1, $2::jsonb)`, [receiptId, lines]),
      );
      expect(message).toMatch(/NOT_A_MEMBER/);
    } finally {
      await stranger.end();
    }
  });
});

describe('the parsed receipt is not a client’s to rewrite', () => {
  it('refuses a member editing the lines everybody is claiming against', async () => {
    // It mattered little while `parsed` was read once and forgotten. Now it is
    // the shared list of lines, so a member who can rewrite it can change what
    // everybody else is agreeing to.
    const message = await expectDenied(
      clients[0]!.query(`UPDATE receipts SET parsed = '{"items":[]}'::jsonb WHERE id = $1`, [
        receiptId,
      ]),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('refuses a member inventing a receipt in somebody else’s name', async () => {
    const message = await expectDenied(
      clients[0]!.query(
        `INSERT INTO receipts (group_id, created_by, source, parse_status)
         VALUES ($1, $2, 'camera', 'parsed')`,
        [group.groupId, group.memberIds[3]],
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('still lets everybody in the group read it', async () => {
    const { rows } = await clients[3]!.query(`SELECT id FROM receipts WHERE id = $1`, [receiptId]);
    expect(rows).toHaveLength(1);
  });
});
