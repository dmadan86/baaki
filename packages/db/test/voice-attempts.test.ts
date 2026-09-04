/**
 * Voice quick-add misses, reported to the backend.
 *
 * The two things worth a test here are the same two the feedback table earns:
 * the author is stamped server-side rather than trusted from the caller, and the
 * transcripts are the console's alone to read. A missing REVOKE on the admin
 * read, or a stray SELECT grant, would quietly publish other people's speech
 * behind the anon key that ships in the app binary — a one-line mistake with no
 * symptom.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied, seedGroup } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/** Session-scoped claims: logging is a write, so a rolled-back role will not do. */
async function asProfile<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  try {
    return await run();
  } finally {
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

describe('voice attempts', () => {
  it('stamps the author rather than trusting the caller', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 2 });
    const transcript = `add five hundred for tea ${randomUUID().slice(0, 8)}`;

    const { rows: returned } = await asProfile(profileIds[0]!, () =>
      client.query('SELECT public.waves_log_voice_attempt($1, $2, $3, $4, $5, $6) AS id', [
        transcript,
        'en',
        true,
        0,
        'android',
        '1.2.3',
      ]),
    );
    expect(returned[0].id).not.toBeNull();

    const { rows } = await client.query(
      'SELECT * FROM public.voice_attempts WHERE transcript = $1',
      [transcript],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].profile_id).toBe(profileIds[0]);
    expect(rows[0].locale).toBe('en');
    expect(rows[0].used_model).toBe(true);
    expect(rows[0].item_count).toBe(0);
    expect(rows[0].platform).toBe('android');
    expect(rows[0].app_version).toBe('1.2.3');
  });

  it('returns null quietly, and stores nothing, without a session or a transcript', async () => {
    // No JWT claims set: waves_current_profile_id() is null, so the reporter must
    // return null rather than raise — the client fires it and forgets.
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
    const noSession = await client.query('SELECT public.waves_log_voice_attempt($1) AS id', [
      'nobody is signed in',
    ]);
    expect(noSession.rows[0].id).toBeNull();

    // A signed-in caller with an empty transcript is likewise a no-op.
    const { profileIds } = await seedGroup(client, { memberCount: 1 });
    const empty = await asProfile(profileIds[0]!, () =>
      client.query('SELECT public.waves_log_voice_attempt($1) AS id', ['   ']),
    );
    expect(empty.rows[0].id).toBeNull();

    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM public.voice_attempts WHERE transcript IN ($1, $2)',
      ['nobody is signed in', '   '],
    );
    expect(rows[0].n).toBe(0);
  });

  it('does not let a client read somebody else’s transcript', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 2 });
    const mine = profileIds[0]!;
    const theirs = profileIds[1]!;
    const secret = `private groceries ${randomUUID().slice(0, 8)}`;

    await asProfile(theirs, () =>
      client.query('SELECT public.waves_log_voice_attempt($1)', [secret]),
    );

    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: mine, role: 'authenticated' }),
      ]);
      await client.query('SET LOCAL ROLE authenticated');

      // A savepoint around the denial: a failed statement poisons the whole
      // transaction, so the read below would otherwise fail for the wrong reason.
      await client.query('SAVEPOINT probe');
      const read = await expectDenied(
        client.query('SELECT * FROM public.voice_attempts WHERE transcript = $1', [secret]),
      );
      // No SELECT is granted to authenticated, so the read is refused outright —
      // stronger than an RLS-filtered empty result.
      expect(read).toMatch(/permission denied/i);
      await client.query('ROLLBACK TO SAVEPOINT probe');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('lets a client insert only its own row', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 2 });
    const mine = profileIds[0]!;
    const theirs = profileIds[1]!;

    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: mine, role: 'authenticated' }),
      ]);
      await client.query('SET LOCAL ROLE authenticated');

      // Forging someone else's profile_id on a direct insert is refused by the
      // WITH CHECK on the insert policy.
      await client.query('SAVEPOINT probe');
      const forged = await expectDenied(
        client.query(
          `INSERT INTO public.voice_attempts (profile_id, transcript) VALUES ($1, 'forged')`,
          [theirs],
        ),
      );
      expect(forged).toMatch(/row-level security|permission denied/i);
      await client.query('ROLLBACK TO SAVEPOINT probe');

      // Its own row is allowed.
      await client.query(
        `INSERT INTO public.voice_attempts (profile_id, transcript) VALUES ($1, 'mine')`,
        [mine],
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('keeps the console’s view to the console', async () => {
    for (const role of ['anon', 'authenticated']) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL ROLE ${role}`);
        const message = await expectDenied(
          client.query('SELECT * FROM public.waves_admin_voice_attempts(10)'),
        );
        expect(message, role).toMatch(/permission denied/i);
      } finally {
        await client.query('ROLLBACK');
      }
    }
  });

  it('shows the service role the author, so the team can follow up', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 1 });
    const transcript = `unparseable mumble ${randomUUID().slice(0, 8)}`;
    await asProfile(profileIds[0]!, () =>
      client.query('SELECT public.waves_log_voice_attempt($1, $2)', [transcript, 'ta']),
    );

    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE service_role');
      const { rows } = await client.query('SELECT * FROM public.waves_admin_voice_attempts(200)');
      const found = rows.find((row) => row.transcript === transcript);
      expect(found, 'the logged attempt should be visible to the console').toBeTruthy();
      expect(found.profile_id).toBe(profileIds[0]);
      expect(found.locale).toBe('ta');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
