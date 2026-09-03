/**
 * Claiming notifications to push, and closing them out afterwards.
 *
 * The bug this exists to prevent is the one everybody ships once: a fanout that
 * reads rows and then sends them delivers everything twice the moment two runs
 * overlap, or one times out after the messages have already left. A person who
 * gets every reminder twice turns notifications off, and they never come back.
 *
 * So claiming is an UPDATE, not a SELECT, and the tests below are mostly about
 * what a second run sees.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

interface Claimed {
  id: string;
  kind: string;
  title: string;
  locale: string;
  tokens: string[];
}

async function seedPerson(options: { tokens?: number; locale?: string } = {}): Promise<{
  profileId: string;
  groupId: string;
  tokens: string[];
}> {
  const { tokens: tokenCount = 1, locale = 'en' } = options;
  const { groupId, profileIds } = await seedGroup(client, { memberCount: 1 });
  const profileId = profileIds[0] ?? '';
  await client.query(`UPDATE profiles SET locale = $2 WHERE id = $1`, [profileId, locale]);

  const tokens: string[] = [];
  for (let index = 0; index < tokenCount; index += 1) {
    const token = `ExponentPushToken[${randomUUID()}]`;
    await client.query(
      `INSERT INTO push_tokens (profile_id, expo_push_token, platform) VALUES ($1, $2, 'android')`,
      [profileId, token],
    );
    tokens.push(token);
  }
  return { profileId, groupId, tokens };
}

async function notify(profileId: string, groupId: string, kind = 'trip_nudge_evening') {
  const { rows } = await client.query(
    `SELECT baaki_notify($1, $2, $3, 'Before you forget', 'What did you pay for today?',
                         null, '{"group":"Goa"}'::jsonb, $4) AS id`,
    [profileId, groupId, kind, randomUUID()],
  );
  return String(rows[0]?.id);
}

/**
 * A deliberately large default. The claim takes the oldest unsent rows first,
 * which is the right order in production and means a row written a moment ago
 * can sit behind hundreds written by the other suites running alongside this
 * one — which is exactly how this was a flake before it was this number.
 */
const claim = async (limit = 5000): Promise<Claimed[]> => {
  const { rows } = await client.query(`SELECT * FROM baaki_claim_push_notifications($1)`, [limit]);
  return rows as Claimed[];
};

const statusOf = async (notificationId: string): Promise<string | null> => {
  const { rows } = await client.query(`SELECT push_status FROM notifications WHERE id = $1`, [
    notificationId,
  ]);
  return (rows[0]?.push_status as string | null) ?? null;
};

const mine = (rows: Claimed[], id: string): Claimed | undefined =>
  rows.find((row) => row.id === id);

describe('claiming', () => {
  it('hands over a notification with the devices to send it to', async () => {
    const person = await seedPerson({ tokens: 2 });
    const id = await notify(person.profileId, person.groupId);
    const claimed = mine(await claim(), id);
    expect(claimed?.tokens.sort()).toEqual(person.tokens.sort());
  });

  it('carries the reader’s language, not the server’s', async () => {
    // The row was written by Postgres with no idea who would read it. The push
    // has to say what the inbox says.
    const person = await seedPerson({ locale: 'ta' });
    const id = await notify(person.profileId, person.groupId);
    expect(mine(await claim(), id)?.locale).toBe('ta');
  });

  it('never hands the same one over twice', async () => {
    // The whole reason claiming is an UPDATE.
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);
    expect(mine(await claim(), id)).toBeDefined();
    expect(mine(await claim(), id)).toBeUndefined();
  });

  it('marks it queued so a second run can see it is spoken for', async () => {
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);
    await claim();
    expect(await statusOf(id)).toBe('queued');
  });

  it('skips a device that has been revoked', async () => {
    const person = await seedPerson({ tokens: 2 });
    await client.query(`UPDATE push_tokens SET revoked_at = now() WHERE expo_push_token = $1`, [
      person.tokens[0],
    ]);
    const id = await notify(person.profileId, person.groupId);
    expect(mine(await claim(), id)?.tokens).toEqual([person.tokens[1]]);
  });

  it('closes out somebody with no device rather than retrying them forever', async () => {
    // Plenty of people only ever read the inbox. Leaving those rows unsent
    // would grow the queue without bound.
    const person = await seedPerson({ tokens: 0 });
    const id = await notify(person.profileId, person.groupId);
    expect(mine(await claim(), id)).toBeUndefined();
    expect(await statusOf(id)).toBe('failed');
  });

  it('leaves something stale alone rather than buzzing about last week', async () => {
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);
    await client.query(
      `UPDATE notifications SET created_at = now() - interval '5 days' WHERE id = $1`,
      [id],
    );
    expect(mine(await claim(), id)).toBeUndefined();
    expect(await statusOf(id)).toBeNull();
  });

  it('respects a limit, so one run cannot take the whole table', async () => {
    const person = await seedPerson();
    await notify(person.profileId, person.groupId);
    await notify(person.profileId, person.groupId);
    await notify(person.profileId, person.groupId);
    expect(await claim(2)).toHaveLength(2);
  });
});

describe('finishing', () => {
  it('records what was sent as sent, and no more than that', async () => {
    // Expo accepting a message is not the phone showing it. Saying 'delivered'
    // here would be a claim the UI would repeat.
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);
    await claim();
    await client.query(`SELECT baaki_finish_push(ARRAY[$1]::uuid[], '{}', '{}')`, [id]);
    expect(await statusOf(id)).toBe('sent');
  });

  it('records a refusal as failed', async () => {
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);
    await claim();
    await client.query(`SELECT baaki_finish_push('{}', ARRAY[$1]::uuid[], '{}')`, [id]);
    expect(await statusOf(id)).toBe('failed');
  });

  it('revokes a device the app was uninstalled from', async () => {
    const person = await seedPerson();
    await client.query(`SELECT baaki_finish_push('{}', '{}', ARRAY[$1]::text[])`, [
      person.tokens[0],
    ]);
    const { rows } = await client.query(
      `SELECT revoked_at FROM push_tokens WHERE expo_push_token = $1`,
      [person.tokens[0]],
    );
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it('keeps the row rather than deleting it', async () => {
    // The same token coming back later is a reinstall, not a new device.
    const person = await seedPerson();
    await client.query(`SELECT baaki_finish_push('{}', '{}', ARRAY[$1]::text[])`, [
      person.tokens[0],
    ]);
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM push_tokens WHERE expo_push_token = $1`,
      [person.tokens[0]],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('does not un-revoke a device on a second pass', async () => {
    const person = await seedPerson();
    await client.query(`SELECT baaki_finish_push('{}', '{}', ARRAY[$1]::text[])`, [
      person.tokens[0],
    ]);
    const first = await client.query(
      `SELECT revoked_at FROM push_tokens WHERE expo_push_token = $1`,
      [person.tokens[0]],
    );
    await client.query(`SELECT baaki_finish_push('{}', '{}', ARRAY[$1]::text[])`, [
      person.tokens[0],
    ]);
    const second = await client.query(
      `SELECT revoked_at FROM push_tokens WHERE expo_push_token = $1`,
      [person.tokens[0]],
    );
    expect(second.rows[0]?.revoked_at).toEqual(first.rows[0]?.revoked_at);
  });
});

describe('retry with backoff', () => {
  const attemptsOf = async (
    notificationId: string,
  ): Promise<{ attempts: number; nextRetryAt: string | null }> => {
    const { rows } = await client.query(
      `SELECT push_attempts, push_next_retry_at FROM notifications WHERE id = $1`,
      [notificationId],
    );
    return {
      attempts: Number(rows[0]?.push_attempts ?? 0),
      nextRetryAt: (rows[0]?.push_next_retry_at as string | null) ?? null,
    };
  };

  const fail = async (notificationId: string): Promise<void> => {
    await client.query(`SELECT baaki_finish_push('{}', ARRAY[$1]::uuid[], '{}')`, [notificationId]);
  };

  it('counts the failure and schedules a retry rather than reclaiming it right away', async () => {
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);
    await claim();
    await fail(id);

    const { attempts, nextRetryAt } = await attemptsOf(id);
    expect(attempts).toBe(1);
    expect(nextRetryAt).not.toBeNull();
    // Still 'failed' with backoff pending, not yet due — a second claim right
    // now must not hand it over again.
    expect(mine(await claim(), id)).toBeUndefined();
  });

  it('reclaims a failed row once its backoff has elapsed', async () => {
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);
    await claim();
    await fail(id);

    await client.query(
      `UPDATE notifications SET push_next_retry_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect(mine(await claim(), id)).toBeDefined();
    expect(await statusOf(id)).toBe('queued');
  });

  it('gives up after three failures rather than retrying forever', async () => {
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(mine(await claim(), id)).toBeDefined();
      await fail(id);
      // Jump the backoff so the next loop iteration does not have to wait on
      // real time — but only while a next attempt is still coming. The third
      // failure sets `push_next_retry_at` to null itself (no retry left), and
      // overwriting that back to a past timestamp would just be testing a
      // state the function never actually produces.
      if (attempt < 2) {
        await client.query(
          `UPDATE notifications SET push_next_retry_at = now() - interval '1 second' WHERE id = $1`,
          [id],
        );
      }
    }

    const { attempts, nextRetryAt } = await attemptsOf(id);
    expect(attempts).toBe(3);
    // The third failure schedules nothing further — this is what actually
    // stops the claim from reclaiming it again below.
    expect(nextRetryAt).toBeNull();
    expect(mine(await claim(), id)).toBeUndefined();
    expect(await statusOf(id)).toBe('failed');
  });

  it('leaves the attempt count alone on a plain delivery', async () => {
    const person = await seedPerson();
    const id = await notify(person.profileId, person.groupId);
    await claim();
    await client.query(`SELECT baaki_finish_push(ARRAY[$1]::uuid[], '{}', '{}')`, [id]);

    const { attempts, nextRetryAt } = await attemptsOf(id);
    expect(attempts).toBe(0);
    expect(nextRetryAt).toBeNull();
  });
});

describe('who may run it', () => {
  it('is nobody who is merely signed in', async () => {
    // Claiming reads other people's inboxes. That is the service role's job and
    // nobody else's.
    const person = await seedPerson();
    await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: person.profileId, role: 'authenticated' }),
    ]);
    await client.query(`SET ROLE authenticated`);
    try {
      await expect(client.query(`SELECT baaki_claim_push_notifications(10)`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(client.query(`SELECT baaki_finish_push()`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query(`RESET ROLE`);
      await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  });
});
