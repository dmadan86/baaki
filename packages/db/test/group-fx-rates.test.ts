/**
 * The trip's shared exchange rates, at the trust boundary.
 *
 * The arithmetic of a rate lives in @waves/core; what has to be proven in the
 * database is the same thing every group-visible-admin-set field has to prove:
 * only an admin can move it, the column cannot be written around the RPC, and
 * the RPC refuses a rate that is not one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied, seedGroup, type SeededGroup } from './helpers';

let client: Client;
let group: SeededGroup;

beforeAll(async () => {
  client = await connect();
  // profile 0 = admin, 1 and 2 = members. Group settles in INR.
  group = await seedGroup(client, { memberCount: 3, name: 'Vietnam' });
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query(`UPDATE groups SET fx_rates = NULL WHERE id = $1`, [group.groupId]);
});

/** Committed as a signed-in profile, the way an RLS write really happens. */
async function as<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query('SET ROLE authenticated');
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
  }
}

const fxRates = async (): Promise<Record<string, { num: string; den: string; ts: string; source: string }>> => {
  const { rows } = await client.query(`SELECT fx_rates FROM groups WHERE id = $1`, [group.groupId]);
  return (rows[0]?.fx_rates ?? {}) as Record<string, { num: string; den: string; ts: string; source: string }>;
};

describe('an admin pins a trip rate', () => {
  it('writes one entry keyed by the currency paid in, as an exact rational', async () => {
    await as(group.profileIds[0] as string, () =>
      // 1 ₹ = ₫312, stored as the ratio the client already computed.
      client.query(`SELECT baaki_set_group_fx_rate($1, 'VND', 312, 1, 'manual')`, [group.groupId]),
    );
    const map = await fxRates();
    expect(map.VND).toMatchObject({ num: '312', den: '1', source: 'manual' });
    expect(map.VND?.ts).toBeTruthy();
  });

  it('clears one currency with a null rate, leaving the rest', async () => {
    await as(group.profileIds[0] as string, async () => {
      await client.query(`SELECT baaki_set_group_fx_rate($1, 'VND', 312, 1, 'manual')`, [group.groupId]);
      await client.query(`SELECT baaki_set_group_fx_rate($1, 'THB', 42, 100, 'manual')`, [group.groupId]);
      await client.query(`SELECT baaki_set_group_fx_rate($1, 'VND', NULL, NULL, 'manual')`, [group.groupId]);
    });
    const map = await fxRates();
    expect(map.VND).toBeUndefined();
    expect(map.THB).toMatchObject({ num: '42', den: '100' });
  });
});

describe('what the RPC refuses', () => {
  it('denies a non-admin', async () => {
    const message = await expectDenied(
      as(group.profileIds[1] as string, () =>
        client.query(`SELECT baaki_set_group_fx_rate($1, 'VND', 312, 1, 'manual')`, [group.groupId]),
      ),
    );
    expect(message).toContain('NOT_AN_ADMIN');
  });

  it('refuses the group’s own settle currency', async () => {
    const message = await expectDenied(
      as(group.profileIds[0] as string, () =>
        client.query(`SELECT baaki_set_group_fx_rate($1, 'INR', 1, 1, 'manual')`, [group.groupId]),
      ),
    );
    expect(message).toContain('SAME_CURRENCY');
  });

  it('refuses a non-positive ratio', async () => {
    const message = await expectDenied(
      as(group.profileIds[0] as string, () =>
        client.query(`SELECT baaki_set_group_fx_rate($1, 'VND', 0, 1, 'manual')`, [group.groupId]),
      ),
    );
    expect(message).toContain('INVALID_RATE');
  });
});

describe('the column cannot be written around the RPC', () => {
  it('blocks a direct fx_rates update from a client', async () => {
    const message = await expectDenied(
      as(group.profileIds[0] as string, () =>
        client.query(`UPDATE groups SET fx_rates = '{"VND":{"num":"1","den":"1"}}'::jsonb WHERE id = $1`, [
          group.groupId,
        ]),
      ),
    );
    expect(message).toContain('FORBIDDEN_COLUMN');
  });
});
