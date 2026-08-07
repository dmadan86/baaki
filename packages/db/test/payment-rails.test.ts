/**
 * Which rail the money moved on.
 *
 * `settlements.method` is an enum with four values, one of which is `upi`.
 * Adding Pix, PayNow, Aani and the rest to it would mean `ALTER TYPE ... ADD
 * VALUE`, which does not compose with a migration running in a transaction —
 * so `rail` is a text column beside it, and `method` keeps holding the coarse
 * shape every existing row already has.
 *
 * The thing worth testing is that the two never disagree in a way that loses
 * information: a rail the enum has never heard of still records, and it records
 * as itself.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, seedGroup, type SeededGroup } from './helpers';

let client: Client;
let group: SeededGroup;

beforeAll(async () => {
  client = await connect();
  group = await seedGroup(client, { memberCount: 2, name: 'Dubai' });
});

afterAll(async () => {
  await client.end();
});

async function record(
  method: string,
  rail: string | null,
  mutationId: string | null = randomUUID(),
): Promise<{ id: string; method: string; rail: string | null }> {
  // Session-level, not transaction-local: these statements do not run inside a
  // transaction, and `is_local = true` would discard the claim before the RPC
  // ever read it.
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: group.profileIds[0], role: 'authenticated' }),
  ]);
  const { rows } = await client.query(
    `SELECT baaki_record_settlement($1, $2, $3, 5000, $4, 'AED', NULL, '[]'::jsonb, $5, $6) AS id`,
    [group.groupId, group.memberIds[0], group.memberIds[1], method, mutationId, rail],
  );
  const id = String(rows[0].id);
  const { rows: stored } = await client.query(
    `SELECT method::text AS method, rail FROM settlements WHERE id = $1`,
    [id],
  );
  return { id, method: String(stored[0].method), rail: stored[0].rail };
}

describe('recording which rail was used', () => {
  it('stores a rail the enum has never heard of, as itself', () => {
    // The whole point. Before this, an Aani transfer had nowhere to go: the
    // enum would have rejected it and the settlement would have failed.
    return record('other', 'aani').then((row) => {
      expect(row.rail).toBe('aani');
      expect(row.method).toBe('other');
    });
  });

  it('keeps method and rail agreeing for the four that always existed', async () => {
    for (const value of ['upi', 'cash', 'bank', 'other']) {
      const row = await record(value, value);
      expect(row.method, value).toBe(value);
      expect(row.rail, value).toBe(value);
    }
  });

  it('falls back to the method when a client does not send a rail', async () => {
    // An app build from before this migration sends nine arguments. It must
    // keep working, and what it recorded must still be readable as a rail.
    const row = await record('cash', null);
    expect(row.rail).toBe('cash');
    expect(row.method).toBe('cash');
  });

  it('refuses a rail that is not a rail', async () => {
    await expect(record('other', 'bitcoin')).rejects.toThrow(/settlements_rail_known|violates/i);
  });

  it('still records nothing twice', async () => {
    // Adding a parameter to this function is exactly how idempotency gets lost
    // — the client mutation id has to survive the rewrite, or a retried
    // settlement pays somebody a second time (ADR-005).
    const mutationId = randomUUID();
    const first = await record('cash', 'cash', mutationId);
    const second = await record('cash', 'cash', mutationId);
    expect(second.id).toBe(first.id);

    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM settlements WHERE client_mutation_id = $1`,
      [mutationId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('still writes the activity entry, now naming the rail', async () => {
    const row = await record('other', 'aani');
    const { rows } = await client.query(
      `SELECT payload FROM activity_log WHERE object_id = $1 AND verb = 'settled'`,
      [row.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.rail).toBe('aani');
  });
});

describe('where a group settles', () => {
  it('accepts a group that never says where it is', async () => {
    // The migration backfilled the rows that existed when it ran — everything
    // in this database was Indian, because until now there was nothing else it
    // could be. It did not add a default, and it should not have: 'IN' is the
    // wrong guess for an app that is going elsewhere. A group with no country
    // is a supported state, and `railsFor(null)` answers with bank, cash and
    // the cross-border wallets.
    const id = randomUUID();
    await client.query(
      `INSERT INTO groups (id, name, type, default_currency, created_by)
       VALUES ($1, 'Nowhere', 'other', 'AED', $2)`,
      [id, group.profileIds[0]],
    );
    const { rows } = await client.query(`SELECT country_code FROM groups WHERE id = $1`, [id]);
    expect(rows[0].country_code).toBeNull();
  });

  it('lets a group settle somewhere other than where it was made', async () => {
    await client.query(`UPDATE groups SET country_code = 'AE' WHERE id = $1`, [group.groupId]);
    const { rows } = await client.query(`SELECT country_code FROM groups WHERE id = $1`, [
      group.groupId,
    ]);
    expect(rows[0].country_code).toBe('AE');
  });

  it('carries a handle with the rail it belongs to', async () => {
    // A phone number on its own is an Aani number, a PayNow number or a Zelle
    // number. Storing one without the other is storing something unusable.
    await client.query(
      `UPDATE group_members SET payment_rail = 'aani', payment_handle = '+971501234567' WHERE id = $1`,
      [group.memberIds[0]],
    );
    const { rows } = await client.query(
      `SELECT payment_rail, payment_handle FROM group_members WHERE id = $1`,
      [group.memberIds[0]],
    );
    expect(rows[0].payment_rail).toBe('aani');
    expect(rows[0].payment_handle).toBe('+971501234567');
  });

  it('refuses a rail that is not a rail there too', async () => {
    await expect(
      client.query(`UPDATE group_members SET payment_rail = 'bitcoin' WHERE id = $1`, [
        group.memberIds[0],
      ]),
    ).rejects.toThrow(/group_members_payment_rail_known|violates/i);
  });
});
