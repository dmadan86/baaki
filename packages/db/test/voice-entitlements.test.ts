/**
 * Voice cloud-STT entitlement & metering (A48, Phase 1).
 *
 * The rule under test is per-person, not per-group: a free user is metered
 * against a monthly allowance; a paid person is unlimited; and a groupmate's
 * subscription must NOT lift a free user (unlike the group "full mode" gate).
 * Usage is service-role-only to write and own-row-only to read.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { asRole, connect, expectDenied, seedGroup } from './helpers';

let client: Client;
let free: string;
let paid: string;
let other: string;

beforeAll(async () => {
  client = await connect();
  const group = await seedGroup(client, { memberCount: 3 });
  const [f, p, o] = group.profileIds;
  if (!f || !p || !o) throw new Error('seedGroup should return three member profile ids');
  free = f;
  paid = p;
  other = o;
});

afterAll(async () => {
  await client.query(`DELETE FROM voice_stt_usage WHERE profile_id = ANY($1::uuid[])`, [
    [free, paid, other],
  ]);
  await client.query(`DELETE FROM subscriptions WHERE profile_id = ANY($1::uuid[])`, [
    [free, paid, other],
  ]);
  await client.end();
});

beforeEach(async () => {
  // Usage and subscriptions persist (they are written by the superuser client,
  // not inside a rolled-back asRole tx), so reset them between cases.
  await client.query(`DELETE FROM voice_stt_usage WHERE profile_id = ANY($1::uuid[])`, [
    [free, paid, other],
  ]);
  await client.query(`DELETE FROM subscriptions WHERE profile_id = ANY($1::uuid[])`, [
    [free, paid, other],
  ]);
});

/** Call the client-facing summary RPC as a given signed-in profile. */
async function myAccess(profileId: string): Promise<Record<string, unknown>> {
  return asRole(client, 'authenticated', { sub: profileId, role: 'authenticated' }, async () => {
    const { rows } = await client.query(`SELECT public.waves_my_voice_access() AS a`);
    return rows[0].a as Record<string, unknown>;
  });
}

function makePaid(profileId: string): Promise<unknown> {
  return client.query(
    `INSERT INTO subscriptions (profile_id, tier, period, status, current_period_end, store)
     VALUES ($1, 'plus', 'monthly', 'active', now() + interval '30 days', 'play')`,
    [profileId],
  );
}

describe('voice STT entitlement (A48 Phase 1)', () => {
  it('gives a free user the default monthly allowance', async () => {
    const access = await myAccess(free);
    expect(access.paid).toBe(false);
    expect(access.freeSeconds).toBe(300);
    expect(access.usedSeconds).toBe(0);
    expect(access.remainingSeconds).toBe(300);
  });

  it('counts recorded seconds down from the allowance', async () => {
    await client.query(`SELECT public.waves_voice_stt_record($1, 100)`, [free]);
    let access = await myAccess(free);
    expect(access.usedSeconds).toBe(100);
    expect(access.remainingSeconds).toBe(200);

    // A second clip adds to the same month and clamps at zero, never negative.
    await client.query(`SELECT public.waves_voice_stt_record($1, 250)`, [free]);
    access = await myAccess(free);
    expect(access.usedSeconds).toBe(350);
    expect(access.remainingSeconds).toBe(0);
  });

  it('treats a paid person as unlimited (remaining = null), ignoring usage', async () => {
    await makePaid(paid);
    await client.query(`SELECT public.waves_voice_stt_record($1, 500)`, [paid]);
    const access = await myAccess(paid);
    expect(access.paid).toBe(true);
    expect(access.remainingSeconds).toBeNull();
    const { rows } = await client.query(
      `SELECT public.waves_voice_stt_remaining_seconds($1) AS r`,
      [paid],
    );
    expect(rows[0].r).toBeNull();
  });

  it('does NOT lift a free user because a groupmate is paid (per-person, not per-group)', async () => {
    await makePaid(paid); // paid is in the same seeded group as `free`
    const access = await myAccess(free);
    expect(access.paid).toBe(false);
    expect(access.remainingSeconds).toBe(300);
  });

  it("resets by calendar month — last month's usage does not count against this month", async () => {
    // Drop a big usage row into an old period directly; the current-month reader
    // must ignore it.
    await client.query(
      `INSERT INTO voice_stt_usage (profile_id, period, seconds) VALUES ($1, '2020-01', 9999)`,
      [other],
    );
    const access = await myAccess(other);
    expect(access.usedSeconds).toBe(0);
    expect(access.remainingSeconds).toBe(300);
  });

  it('lets the allowance be re-tuned from app_config', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE app_config SET value = 120 WHERE key = 'voice_stt_free_seconds'`);
      const { rows } = await client.query(`SELECT public.waves_voice_stt_free_seconds() AS s`);
      expect(rows[0].s).toBe(120);
    } finally {
      await client.query('ROLLBACK'); // keep the seeded default for other tests
    }
  });
});

describe('voice STT metering is not client-forgeable', () => {
  it('refuses waves_voice_stt_record to an ordinary authenticated caller', async () => {
    // The EXECUTE grant is service-role only; authenticated is denied.
    const message = await expectDenied(
      asRole(client, 'authenticated', { sub: free, role: 'authenticated' }, () =>
        client.query(`SELECT public.waves_voice_stt_record($1, 50)`, [free]),
      ),
    );
    expect(message).toMatch(/permission denied|not.*allowed/i);
  });

  it("does not let one user read another user's usage row", async () => {
    await client.query(`SELECT public.waves_voice_stt_record($1, 42)`, [free]);
    const seen = await asRole(
      client,
      'authenticated',
      { sub: other, role: 'authenticated' },
      async () => {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM voice_stt_usage WHERE profile_id = $1`,
          [free],
        );
        return rows[0].n as number;
      },
    );
    expect(seen).toBe(0);
  });

  it('rejects a negative record', async () => {
    const message = await expectDenied(
      client.query(`SELECT public.waves_voice_stt_record($1, -5)`, [free]),
    );
    expect(message).toContain('VOICE_STT_BAD_SECONDS');
  });
});

describe('service_config text knobs', () => {
  it('seeds the provider default and is readable by an authenticated user', async () => {
    const value = await asRole(
      client,
      'authenticated',
      { sub: free, role: 'authenticated' },
      async () => {
        const { rows } = await client.query(
          `SELECT value FROM service_config WHERE key = 'voice_stt_provider'`,
        );
        return rows[0]?.value as string;
      },
    );
    expect(value).toBe('deepgram');
  });
});
