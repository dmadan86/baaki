/**
 * The device cap: an admin knob, and an A/B experiment over the number.
 *
 * The paid/free device limits used to be two integer literals inside
 * baaki_register_device. This pins the behaviour that replaced them:
 *
 *   - a free account resolves to the `device_cap_free` knob, a paid one to
 *     `device_cap_plus` — both editable from the console with no deploy;
 *   - turning a knob changes the limit the RPC hands back;
 *   - an enabled experiment (`device_cap_free_ab` / `device_cap_plus_ab`) whose
 *     arm is a number overrides the knob for the accounts it enrolls, by the
 *     same FNV-1a bucket the app and console share;
 *   - a non-numeric arm is ignored — the cap falls back to the knob, never to
 *     nonsense;
 *   - the cap stays soft: over the line reports `overLimit`, it never throws.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { connect } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

// Every test builds its own profiles/devices; wipe them and restore the shared
// config the migration seeded, so a knob one test turns cannot leak into the
// next.
afterEach(async () => {
  await client.query(`DELETE FROM device_sessions`);
  await client.query(`DELETE FROM subscriptions`);
  await client.query(`UPDATE app_config SET value = 2 WHERE key = 'device_cap_free'`);
  await client.query(`UPDATE app_config SET value = 3 WHERE key = 'device_cap_plus'`);
  await client.query(
    `UPDATE feature_flags SET enabled = false, rollout_percent = 0, variants = ARRAY['2','3'] WHERE key = 'device_cap_free_ab'`,
  );
  await client.query(
    `UPDATE feature_flags SET enabled = false, rollout_percent = 0, variants = ARRAY['3','5'] WHERE key = 'device_cap_plus_ab'`,
  );
});

async function makeProfile(): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'X', 'INR')`,
    [id],
  );
  return id;
}

async function makePlus(profileId: string): Promise<void> {
  await client.query(
    `INSERT INTO subscriptions (profile_id, tier, period, status, current_period_end, store)
     VALUES ($1, 'plus', 'monthly', 'active', now() + interval '30 days', 'play')`,
    [profileId],
  );
}

interface RegisterResult {
  tier: string | null;
  limit: number;
  activeCount: number;
  overLimit: boolean;
}

/** Register a device as the given profile, returning the RPC's status object. */
async function register(
  profileId: string,
  deviceId: string,
  platform = 'android',
): Promise<RegisterResult> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  const { rows } = await client.query(
    `SELECT public.baaki_register_device($1, 'A phone', $2, null) AS r`,
    [deviceId, platform],
  );
  await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  return rows[0].r as RegisterResult;
}

/** The arm a profile is on for a flag, or null — the same source the app reads. */
async function armFor(flagKey: string, profileId: string): Promise<string | null> {
  const { rows } = await client.query(`SELECT public.baaki_variant($1, $2) AS v`, [
    flagKey,
    profileId,
  ]);
  return rows[0].v as string | null;
}

describe('the device cap', () => {
  it('resolves a free account to the device_cap_free knob (default 2)', async () => {
    const p = await makeProfile();
    const r = await register(p, randomUUID());
    expect(r.limit).toBe(2);
  });

  it('resolves a paid account to the device_cap_plus knob (default 3)', async () => {
    const p = await makeProfile();
    await makePlus(p);
    const r = await register(p, randomUUID());
    expect(r.tier).toBe('plus');
    expect(r.limit).toBe(3);
  });

  it('follows the knob when the console turns it', async () => {
    const p = await makeProfile();
    await client.query(`UPDATE app_config SET value = 5 WHERE key = 'device_cap_free'`);
    const r = await register(p, randomUUID());
    expect(r.limit).toBe(5);
  });

  it('lets an enabled experiment override the knob with its arm number', async () => {
    const p = await makeProfile();
    // Knob says 5, but a full-rollout experiment with numeric arms should win.
    await client.query(`UPDATE app_config SET value = 5 WHERE key = 'device_cap_free'`);
    await client.query(
      `UPDATE feature_flags SET enabled = true, rollout_percent = 100, variants = ARRAY['7','9'] WHERE key = 'device_cap_free_ab'`,
    );

    const arm = await armFor('device_cap_free_ab', p);
    expect(arm).not.toBeNull();

    const r = await register(p, randomUUID());
    expect(r.limit).toBe(Number(arm)); // exactly the arm the bucket assigned
    expect([7, 9]).toContain(r.limit); // and never the knob's 5
  });

  it('ignores a non-numeric arm and falls back to the knob', async () => {
    const p = await makeProfile();
    await client.query(`UPDATE app_config SET value = 4 WHERE key = 'device_cap_free'`);
    await client.query(
      `UPDATE feature_flags SET enabled = true, rollout_percent = 100, variants = ARRAY['control','treatment'] WHERE key = 'device_cap_free_ab'`,
    );

    const r = await register(p, randomUUID());
    expect(r.limit).toBe(4); // the arm is not a number; the knob stands
  });

  it('reports over-limit softly — the third free device registers, it is not refused', async () => {
    const p = await makeProfile();
    await register(p, randomUUID());
    await register(p, randomUUID());
    const third = await register(p, randomUUID()); // limit 2, now three active

    expect(third.activeCount).toBe(3);
    expect(third.overLimit).toBe(true); // over the line, but the call succeeded
  });
});
