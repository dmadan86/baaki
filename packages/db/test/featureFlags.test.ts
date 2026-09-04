/**
 * The half of the bucketer that lives in SQL.
 *
 * The first test here is the one that matters. The app decides what to show
 * from `bucketOf` in `@waves/core`; the console counts what happened using
 * `waves_bucket` in plpgsql. They are the same algorithm written twice, and if
 * they ever disagree the experiment results are not missing but **wrong** —
 * every number plausible, every conclusion backwards. `BUCKET_FIXTURES` is the
 * contract between them, asserted here against the SQL and in
 * `packages/core/test/flags.test.ts` against the TypeScript.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { BUCKET_FIXTURES, variantFor, type FeatureFlag } from '@waves/core';

import { connect, expectDenied } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function bucket(input: string): Promise<number> {
  const { rows } = await client.query('SELECT public.waves_bucket($1) AS b', [input]);
  return Number(rows[0].b);
}

async function upsertFlag(flag: FeatureFlag & { description?: string }): Promise<void> {
  await client.query(
    `INSERT INTO public.feature_flags (key, description, enabled, rollout_percent, variants)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           rollout_percent = EXCLUDED.rollout_percent,
           variants = EXCLUDED.variants`,
    [flag.key, flag.description ?? '', flag.enabled, flag.rolloutPercent, flag.variants],
  );
}

describe('the two implementations of one hash', () => {
  it('agrees with the TypeScript on every fixture', async () => {
    for (const fixture of BUCKET_FIXTURES) {
      expect(await bucket(fixture.input), JSON.stringify(fixture.input)).toBe(fixture.bucket);
    }
  });

  it('agrees on a few hundred realistic inputs', async () => {
    // The fixtures pin known values; this checks the two agree in general,
    // which is what actually breaks — a subtle difference in how the multiply
    // wraps shows up on some inputs and not others.
    const inputs = Array.from({ length: 200 }, () => `some_flag:${randomUUID()}`);
    const { rows } = await client.query(
      'SELECT i AS input, public.waves_bucket(i) AS b FROM unnest($1::text[]) AS i',
      [inputs],
    );
    const { bucketOf } = await import('@waves/core');
    for (const row of rows) {
      expect(Number(row.b), row.input).toBe(bucketOf(row.input));
    }
  });

  it('reaches the same verdict as variantFor', async () => {
    const flag: FeatureFlag = {
      key: 'shared_itemizing',
      enabled: true,
      rolloutPercent: 60,
      variants: ['control', 'treatment'],
    };
    await upsertFlag(flag);

    const profileIds = Array.from({ length: 120 }, () => randomUUID());
    const { rows } = await client.query(
      'SELECT p AS id, public.waves_variant($2, p::uuid) AS v FROM unnest($1::uuid[]) AS p',
      [profileIds, flag.key],
    );

    for (const row of rows) {
      expect(row.v, row.id).toBe(variantFor(flag, row.id));
    }
    // And the rollout actually excluded somebody, or this proved nothing.
    expect(rows.some((row) => row.v === null)).toBe(true);
    expect(rows.some((row) => row.v !== null)).toBe(true);
  });
});

describe('the switch', () => {
  it('says nothing for a flag nobody has created', async () => {
    expect(
      (
        await client.query('SELECT public.waves_variant($1, $2) AS v', [
          'no_such_flag',
          randomUUID(),
        ])
      ).rows[0].v,
    ).toBeNull();
  });

  it('says nothing while the flag is off', async () => {
    await upsertFlag({
      key: 'off_flag',
      enabled: false,
      rolloutPercent: 100,
      variants: ['control', 'treatment'],
    });
    const { rows } = await client.query('SELECT public.waves_variant($1, $2) AS v', [
      'off_flag',
      randomUUID(),
    ]);
    expect(rows[0].v).toBeNull();
  });

  it('refuses a malformed key, a bad rollout and a duplicated arm', async () => {
    // Each of these is a way to get an experiment that looks fine and splits
    // wrong, so they are constraints rather than conventions.
    await expectDenied(client.query(`INSERT INTO public.feature_flags (key) VALUES ('Not A Key')`));
    await expectDenied(
      client.query(
        `INSERT INTO public.feature_flags (key, rollout_percent) VALUES ('too_much', 101)`,
      ),
    );
    await expectDenied(
      client.query(
        `INSERT INTO public.feature_flags (key, variants) VALUES ('dupe', ARRAY['a','a'])`,
      ),
    );
    await expectDenied(
      client.query(`INSERT INTO public.feature_flags (key, variants) VALUES ('one', ARRAY['a'])`),
    );
  });
});

describe('who may change a flag', () => {
  async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      return await run();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  it('lets a signed-in client read', async () => {
    await upsertFlag({
      key: 'readable',
      enabled: true,
      rolloutPercent: 50,
      variants: ['control', 'treatment'],
    });
    await asRole('authenticated', async () => {
      const { rows } = await client.query(
        `SELECT * FROM public.feature_flags WHERE key = 'readable'`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  it('refuses every client write', async () => {
    // The whole point. A flag a client can flip is a paywall with a back door.
    for (const role of ['anon', 'authenticated']) {
      const insert = await asRole(role, () =>
        expectDenied(
          client.query(`INSERT INTO public.feature_flags (key) VALUES ('sneaky_${role}')`),
        ),
      );
      expect(insert, role).toMatch(/permission denied|violates row-level security/i);

      const update = await asRole(role, () =>
        expectDenied(
          client.query(`UPDATE public.feature_flags SET enabled = true WHERE key = 'readable'`),
        ),
      );
      expect(update, role).toMatch(/permission denied/i);
    }
  });

  it('keeps the results to the console', async () => {
    for (const role of ['anon', 'authenticated']) {
      const message = await asRole(role, () =>
        expectDenied(client.query(`SELECT * FROM public.waves_admin_flag_results('readable')`)),
      );
      expect(message, role).toMatch(/permission denied/i);
    }
  });
});

describe('the result', () => {
  it('reports one row per arm and never a row for the unenrolled', async () => {
    await upsertFlag({
      key: 'results_flag',
      enabled: true,
      rolloutPercent: 100,
      variants: ['control', 'treatment'],
    });

    // Enrolment is computed over public.profiles, so seed a population or the
    // result is empty in a fresh database and the assertions pass vacuously.
    const seeded = Array.from({ length: 40 }, () => randomUUID());
    await client.query(
      `INSERT INTO public.profiles (id, display_name)
       SELECT p, 'Flag tester' FROM unnest($1::uuid[]) AS p`,
      [seeded],
    );

    const { rows } = await client.query(
      `SELECT * FROM public.waves_admin_flag_results('results_flag')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.variant !== null)).toBe(true);
    expect(new Set(rows.map((row) => row.variant)).size).toBe(rows.length);
    for (const row of rows) {
      expect(['control', 'treatment']).toContain(row.variant);
    }
  });

  it('enrols nobody at 0%', async () => {
    await upsertFlag({
      key: 'nobody_flag',
      enabled: true,
      rolloutPercent: 0,
      variants: ['control', 'treatment'],
    });
    const { rows } = await client.query(
      `SELECT * FROM public.waves_admin_flag_results('nobody_flag')`,
    );
    expect(rows).toHaveLength(0);
  });
});
