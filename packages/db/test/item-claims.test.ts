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

import { CONNECTION_STRING, connect, expectDenied, seedGroup, type SeededGroup } from './helpers';

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
