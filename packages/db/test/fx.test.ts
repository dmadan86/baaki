/**
 * A rate that converts the wrong way is worse than no rate at all — it converts
 * confidently and wrongly, and nothing downstream can tell.
 *
 * These tests pin the server-side validation, because the client that supplies
 * the rate is exactly the thing that cannot be trusted to have got it right
 * (ADR-013). The direction checks are the point: `from` must be the expense's
 * currency and `to` must be the group's, or a EUR expense in an INR group could
 * be stored with an INR→EUR rate and display as a hundredth of its value.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

const rate = (overrides: Record<string, unknown> = {}) => ({
  num: '9125',
  den: '100',
  from: 'EUR',
  to: 'INR',
  ts: '2026-08-05T00:00:00.000Z',
  source: 'manual',
  ...overrides,
});

async function assertFx(
  fx: unknown,
  expenseCurrency: string,
  groupCurrency: string,
): Promise<string | null> {
  try {
    await client.query(`SELECT baaki_assert_fx_valid($1::jsonb, $2::char(3), $3::char(3))`, [
      fx === null ? null : JSON.stringify(fx),
      expenseCurrency,
      groupCurrency,
    ]);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('a rate the server will accept', () => {
  it('accepts a well-formed rate in the right direction', async () => {
    expect(await assertFx(rate(), 'EUR', 'INR')).toBeNull();
  });

  it('accepts no rate at all — most expenses are in the group currency', async () => {
    expect(await assertFx(null, 'INR', 'INR')).toBeNull();
  });
});

describe('a rate the server refuses', () => {
  it('refuses a rate whose source currency is not the expense currency', async () => {
    const message = await assertFx(rate({ from: 'USD' }), 'EUR', 'INR');
    expect(message).toMatch(/FX_DIRECTION: fx rate converts from USD but the expense is in EUR/);
  });

  it('refuses a rate that does not land in the group currency', async () => {
    const message = await assertFx(rate({ to: 'USD' }), 'EUR', 'INR');
    expect(message).toMatch(/FX_DIRECTION: fx rate converts to USD but the group settles in INR/);
  });

  it('refuses a rate on an expense that needs no conversion', async () => {
    // Nothing good comes of an INR expense in an INR group carrying a rate:
    // whichever direction it claims, applying it would be wrong.
    const message = await assertFx(rate({ from: 'INR', to: 'INR' }), 'INR', 'INR');
    expect(message).toMatch(/FX_NOT_NEEDED: .*already in the group currency/);
  });

  it('refuses a rate stored as a number rather than an integer string', async () => {
    // 91.25 as JSON is a double, and the whole point of the rational is that no
    // double ever exists between what was typed and what is stored (ADR-003).
    const message = await assertFx(rate({ num: 91.25, den: 1 }), 'EUR', 'INR');
    expect(message).toMatch(/FX_NOT_RATIONAL: .*integer strings/);
  });

  it('refuses a zero or negative rate', async () => {
    expect(await assertFx(rate({ num: '0' }), 'EUR', 'INR')).toMatch(
      /FX_NOT_RATIONAL: fx rate must be positive/,
    );
    expect(await assertFx(rate({ den: '0' }), 'EUR', 'INR')).toMatch(
      /FX_NOT_RATIONAL: fx rate must be positive/,
    );
    expect(await assertFx(rate({ num: '-1' }), 'EUR', 'INR')).toMatch(
      /FX_NOT_RATIONAL: .*integer strings/,
    );
  });

  it('refuses a rate that will not say where it came from', async () => {
    expect(await assertFx(rate({ source: '' }), 'EUR', 'INR')).toMatch(
      /FX_NO_PROVENANCE: .*where it came from/,
    );
    expect(await assertFx(rate({ source: null }), 'EUR', 'INR')).toMatch(
      /FX_NO_PROVENANCE: .*where it came from/,
    );
  });

  it('refuses a rate with no timestamp', async () => {
    expect(await assertFx(rate({ ts: null }), 'EUR', 'INR')).toMatch(
      /FX_NO_PROVENANCE: .*instant it was captured/,
    );
  });
});

describe('the rate on the expense itself', () => {
  async function seedGroup(groupCurrency: string): Promise<{ groupId: string; memberId: string }> {
    const profileId = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Asha')`, [profileId]);
    await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: profileId, role: 'authenticated' }),
    ]);
    await client.query(`SET ROLE authenticated`);
    const { rows } = await client.query(
      `SELECT baaki_create_group('Trip', 'trip', $1, NULL, true, NULL, NULL) AS id`,
      [groupCurrency],
    );
    const groupId = String(rows[0].id);
    await client.query(`RESET ROLE`);
    const members = await client.query(
      `SELECT id FROM group_members WHERE group_id = $1 AND profile_id = $2`,
      [groupId, profileId],
    );
    await client.query(`SET ROLE authenticated`);
    return { groupId, memberId: String(members.rows[0].id) };
  }

  async function write(
    groupId: string,
    memberId: string,
    currency: string,
    fx: unknown,
  ): Promise<string | null> {
    try {
      await client.query(
        `SELECT baaki_apply_expense($1::uuid, $2::uuid, $3::uuid, 'Dinner', NULL::text,
                                    '2026-08-05'::date, $4::char(3), 1000::bigint,
                                    'equal'::text, '{"kind":"equal"}'::jsonb,
                                    $5::jsonb, $6::jsonb, $7::uuid,
                                    NULL::text, NULL::uuid, NULL::int, $8::jsonb)`,
        [
          groupId,
          randomUUID(),
          memberId,
          currency,
          JSON.stringify([{ memberId, amount: '1000' }]),
          JSON.stringify([{ memberId, amount: '1000' }]),
          randomUUID(),
          fx === null ? null : JSON.stringify(fx),
        ],
      );
      return null;
    } catch (error) {
      return (error as Error).message;
    } finally {
      await client.query(`RESET ROLE`);
      await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  }

  it('stores the rate on the version it belongs to', async () => {
    const { groupId, memberId } = await seedGroup('INR');
    expect(await write(groupId, memberId, 'EUR', rate())).toBeNull();

    const { rows } = await client.query(
      `SELECT ev.fx, ev.currency FROM expense_versions ev
         JOIN expenses e ON e.id = ev.expense_id
        WHERE e.group_id = $1`,
      [groupId],
    );
    expect(rows[0].currency).toBe('EUR');
    expect(rows[0].fx).toEqual(rate());
  });

  it('refuses to write an expense carrying a backwards rate', async () => {
    const { groupId, memberId } = await seedGroup('INR');
    const message = await write(groupId, memberId, 'EUR', rate({ from: 'INR', to: 'EUR' }));
    expect(message).toMatch(/FX_DIRECTION: fx rate converts from INR but the expense is in EUR/);

    // And nothing was written — the check happens before the first insert.
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM expenses WHERE group_id = $1`,
      [groupId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('still writes an ordinary expense with no rate at all', async () => {
    const { groupId, memberId } = await seedGroup('INR');
    expect(await write(groupId, memberId, 'INR', null)).toBeNull();
  });
});
