/**
 * The version policy is the one table in the database that can lock every
 * phone out of its own ledger, so what it refuses matters more than what it
 * stores.
 *
 * Two properties, both about the blast radius of a mistake:
 *
 *   - anybody can read it, including a signed-out guest, because the gate runs
 *     before the sign-in screen;
 *   - nobody can write it, including a signed-in person, because "which builds
 *     are allowed to open" is not a thing a client gets to decide.
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

async function asRole<T>(
  role: 'anon' | 'authenticated',
  claims: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify(claims),
  ]);
  await client.query(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await client.query(`RESET ROLE`);
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

describe('app_releases', () => {
  it('is readable signed out, because the gate runs before sign-in', async () => {
    const rows = await asRole('anon', { role: 'anon' }, async () => {
      const result = await client.query(`SELECT platform, store_url FROM app_releases`);
      return result.rows;
    });

    expect(rows.map((row) => row.platform).sort()).toEqual(['android', 'ios']);
    // A forced update with no way past it is worse than no forced update.
    for (const row of rows) expect(row.store_url).toMatch(/^https:\/\//);
  });

  it('cannot be written by a signed-in person', async () => {
    const profileId = randomUUID();
    await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, 'Someone')`, [
      profileId,
    ]);

    await asRole('authenticated', { sub: profileId, role: 'authenticated' }, async () => {
      // No policy for UPDATE means no rows are visible to update: Postgres
      // reports success having changed nothing rather than refusing.
      const updated = await client.query(
        `UPDATE app_releases SET minimum_version = '99.0.0' WHERE platform = 'android'`,
      );
      expect(updated.rowCount).toBe(0);

      await expect(
        client.query(
          `INSERT INTO app_releases (platform, latest_version, minimum_version, store_url)
           VALUES ('android', '99.0.0', '99.0.0', 'https://evil.example')
           ON CONFLICT (platform) DO UPDATE SET minimum_version = '99.0.0'`,
        ),
      ).rejects.toThrow(/row-level security|policy/i);
    });

    const after = await client.query(
      `SELECT minimum_version FROM app_releases WHERE platform = 'android'`,
    );
    expect(after.rows[0]?.minimum_version).not.toBe('99.0.0');
  });

  it('refuses a minimum above the latest, which would block every build', async () => {
    await expect(
      client.query(`UPDATE app_releases SET minimum_version = '99.0.0' WHERE platform = 'android'`),
    ).rejects.toThrow(/app_releases_minimum_not_above_latest/);
  });

  it('refuses a version string the client would not be able to compare', async () => {
    for (const bad of ['v2', '2.0-rc1', 'latest']) {
      await expect(
        client.query(`UPDATE app_releases SET latest_version = $1 WHERE platform = 'android'`, [
          bad,
        ]),
      ).rejects.toThrow(/check constraint/);
    }
  });

  it('orders versions by segment, the way the client does', async () => {
    const { rows } = await client.query(
      `SELECT baaki_version_key('1.10.0') > baaki_version_key('1.9.0') AS newer,
              baaki_version_key('1.2')   = baaki_version_key('1.2.0') AS same`,
    );
    expect(rows[0]).toEqual({ newer: true, same: true });
  });
});
