/**
 * The email half of the notification pipeline (TDR §7.3).
 *
 * Three things here are worth more than the rest, and they are the three that
 * are expensive to get wrong in production and cheap to get wrong in a diff:
 *
 *   * **Nothing goes out twice.** The claim is an UPDATE, so two overlapping
 *     runs cannot both take the same row. A duplicate push is annoying; a
 *     duplicate "confirm you were paid ₹420" is a person wondering whether they
 *     were paid twice.
 *   * **A no stays a no.** A bounce, a complaint or an unsubscribe has to stop
 *     the next send, and the check has to happen before anything is handed to
 *     Resend. Mailing an address that complained is how a sending domain dies.
 *   * **Nobody signed in can reach any of it.** `baaki_email_for` turns a
 *     profile id — which every group member can see — into somebody's email
 *     address, and it is the sharpest function in the schema for that reason.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { asRole, connect, expectDenied, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
  // CI runs against bare Postgres, which has no `auth` schema — Supabase owns
  // that one. `baaki_email_for` looks it up dynamically and returns NULL when it
  // is absent, which is correct and also untestable. This is the smallest shim
  // that lets the address path be exercised at all: the three columns the
  // function reads, and nothing else.
  await client.query(`CREATE SCHEMA IF NOT EXISTS auth`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS auth.users (
       id uuid PRIMARY KEY,
       email text,
       email_confirmed_at timestamptz
     )`,
  );
});

afterAll(async () => {
  await client?.end();
});

interface Claimed {
  id: string;
  kind: string;
  title: string;
  locale: string;
  address: string | null;
  group_name: string | null;
  deep_link: string | null;
}

async function seedPerson(
  options: { email?: string | null; confirmed?: boolean; tokens?: number; locale?: string } = {},
): Promise<{ profileId: string; groupId: string; address: string }> {
  const {
    email = `${randomUUID()}@example.com`,
    confirmed = true,
    tokens = 0,
    locale = 'en',
  } = options;

  const { groupId, profileIds } = await seedGroup(client, { memberCount: 1, name: 'Goa trip' });
  const profileId = profileIds[0] ?? '';
  await client.query(`UPDATE profiles SET locale = $2 WHERE id = $1`, [profileId, locale]);

  if (email) {
    await client.query(
      `INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, $3)`,
      [profileId, email, confirmed ? new Date().toISOString() : null],
    );
  }

  for (let index = 0; index < tokens; index += 1) {
    await client.query(
      `INSERT INTO push_tokens (profile_id, expo_push_token, platform)
       VALUES ($1, $2, 'android')`,
      [profileId, `ExponentPushToken[${randomUUID()}]`],
    );
  }

  return { profileId, groupId, address: email ?? '' };
}

async function notify(
  profileId: string,
  groupId: string,
  kind = 'settlement_confirm_request',
): Promise<string> {
  const { rows } = await client.query(
    `SELECT baaki_notify($1, $2, $3, 'They say they paid you', 'Confirm so your baaki stays right',
                         null, '{"amount":"42000","currency":"INR"}'::jsonb, $4) AS id`,
    [profileId, groupId, kind, randomUUID()],
  );
  return String(rows[0]?.id);
}

/**
 * Reports the rows claimed for one profile.
 *
 * The claim itself is NOT scoped to that profile: baaki_claim_email_notifications(500)
 * claims up to 500 rows across the whole notifications table and marks them
 * `queued`. The `JOIN … WHERE n.profile_id = $1` only filters which of those
 * already-claimed rows are returned here — rows belonging to other profiles are
 * still claimed and their email_status is still changed as a side effect. The
 * suite gets away with this because each test seeds a fresh profile and no other
 * test asserts on those other rows' email_status.
 */
async function claimFor(profileId: string): Promise<Claimed[]> {
  const { rows } = await client.query<Claimed>(
    `SELECT c.* FROM baaki_claim_email_notifications(500) c
       JOIN notifications n ON n.id = c.id
      WHERE n.profile_id = $1`,
    [profileId],
  );
  return rows;
}

async function statusOf(notificationId: string): Promise<string | null> {
  const { rows } = await client.query(`SELECT email_status FROM notifications WHERE id = $1`, [
    notificationId,
  ]);
  return rows[0]?.email_status ?? null;
}

/** Push's own outcome for a row — what the email fallback's gate actually reads. */
async function pushStateOf(
  notificationId: string,
): Promise<{ pushStatus: string | null; pushNextRetryAt: string | null }> {
  const { rows } = await client.query(
    `SELECT push_status, push_next_retry_at FROM notifications WHERE id = $1`,
    [notificationId],
  );
  return {
    pushStatus: (rows[0]?.push_status as string | null) ?? null,
    pushNextRetryAt: (rows[0]?.push_next_retry_at as string | null) ?? null,
  };
}

describe('what gets claimed', () => {
  it('claims a settlement confirmation, with the address and the group', async () => {
    const { profileId, groupId, address } = await seedPerson();
    const id = await notify(profileId, groupId);

    const claimed = await claimFor(profileId);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(id);
    expect(claimed[0]?.address).toBe(address);
    expect(claimed[0]?.group_name).toBe('Goa trip');
    expect(await statusOf(id)).toBe('queued');
  });

  /**
   * The list that keeps this from becoming Splitwise. `expense_added` is the
   * commonest notification in the app by an order of magnitude, and mailing it
   * is the single change that would make people filter the sender.
   */
  it('never claims routine ledger activity, whatever else is true', async () => {
    const { profileId, groupId } = await seedPerson();
    for (const kind of ['expense_added', 'expense_edited', 'you_owe', 'group_invite_accepted']) {
      await notify(profileId, groupId, kind);
    }

    expect(await claimFor(profileId)).toHaveLength(0);
  });

  it('leaves a kind it will not mail untouched rather than closing it out', async () => {
    const { profileId, groupId } = await seedPerson();
    const id = await notify(profileId, groupId, 'expense_added');
    await claimFor(profileId);
    // Still NULL: a future rule change may decide differently, and 'suppressed'
    // would be a decision this run never made.
    expect(await statusOf(id)).toBeNull();
  });

  it('does not claim the same row twice', async () => {
    const { profileId, groupId } = await seedPerson();
    await notify(profileId, groupId);

    expect(await claimFor(profileId)).toHaveLength(1);
    expect(await claimFor(profileId)).toHaveLength(0);
  });

  it('ignores anything older than two days', async () => {
    const { profileId, groupId } = await seedPerson();
    const id = await notify(profileId, groupId);
    await client.query(
      `UPDATE notifications SET created_at = now() - interval '3 days' WHERE id = $1`,
      [id],
    );

    expect(await claimFor(profileId)).toHaveLength(0);
  });
});

describe('who does not get mailed', () => {
  it('skips somebody with no address at all', async () => {
    const { profileId, groupId } = await seedPerson({ email: null });
    const id = await notify(profileId, groupId);

    expect(await claimFor(profileId)).toHaveLength(0);
    expect(await statusOf(id)).toBe('suppressed');
  });

  /**
   * Somebody typed the address; until they have proved they read it, mailing it
   * is mailing a stranger who did not ask.
   */
  it('skips an address that was never confirmed', async () => {
    const { profileId, groupId } = await seedPerson({ confirmed: false });
    const id = await notify(profileId, groupId);

    expect(await claimFor(profileId)).toHaveLength(0);
    expect(await statusOf(id)).toBe('suppressed');
  });

  it('respects email being turned off in preferences', async () => {
    const { profileId, groupId } = await seedPerson();
    await client.query(
      `UPDATE profiles SET notification_prefs = '{"email":false}'::jsonb WHERE id = $1`,
      [profileId],
    );
    const id = await notify(profileId, groupId);

    expect(await claimFor(profileId)).toHaveLength(0);
    expect(await statusOf(id)).toBe('suppressed');
  });

  it('mails by default, because most people never open the settings', async () => {
    const { profileId, groupId } = await seedPerson();
    await client.query(`UPDATE profiles SET notification_prefs = '{}'::jsonb WHERE id = $1`, [
      profileId,
    ]);
    await notify(profileId, groupId);

    expect(await claimFor(profileId)).toHaveLength(1);
  });

  it('skips an address on the suppression list', async () => {
    const { profileId, groupId, address } = await seedPerson();
    await client.query(`SELECT baaki_suppress_email($1, 'complained')`, [address]);
    const id = await notify(profileId, groupId);

    expect(await claimFor(profileId)).toHaveLength(0);
    expect(await statusOf(id)).toBe('suppressed');
  });

  it('matches the suppression however the address was typed', async () => {
    const { profileId, groupId, address } = await seedPerson();
    await client.query(`SELECT baaki_suppress_email($1, 'bounced')`, [
      `  ${address.toUpperCase()} `,
    ]);
    await notify(profileId, groupId);

    expect(await claimFor(profileId)).toHaveLength(0);
  });

  /** TDR §7.4 — a nudge is push-first, and email only where there is no push. */
  it('does not mail a nudge to somebody holding a live device', async () => {
    const { profileId, groupId } = await seedPerson({ tokens: 1 });
    const id = await notify(profileId, groupId, 'nudge');

    expect(await claimFor(profileId)).toHaveLength(0);
    expect(await statusOf(id)).toBe('suppressed');
  });

  it('mails a nudge to somebody with no device', async () => {
    const { profileId, groupId } = await seedPerson({ tokens: 0 });
    await notify(profileId, groupId, 'nudge');

    expect(await claimFor(profileId)).toHaveLength(1);
  });

  it('counts a revoked device as no device', async () => {
    const { profileId, groupId } = await seedPerson({ tokens: 1 });
    await client.query(`UPDATE push_tokens SET revoked_at = now() WHERE profile_id = $1`, [
      profileId,
    ]);
    await notify(profileId, groupId, 'nudge');

    expect(await claimFor(profileId)).toHaveLength(1);
  });

  it('still mails a settlement to somebody with a device — that rule is nudges only', async () => {
    const { profileId, groupId } = await seedPerson({ tokens: 1 });
    await notify(profileId, groupId, 'settlement_confirm_request');

    expect(await claimFor(profileId)).toHaveLength(1);
  });

  /**
   * `group_added` is the fallback for a push that never lands, now that there
   * is no in-app inbox (#565) to check instead. Same rule as a nudge — mailed
   * only where there is no live device, or where push has already given up.
   *
   * Unlike a nudge, that second condition is not known the moment the row is
   * claimed — push can take several fanout runs to find out (the retry
   * backoff), and `email_status IS NULL` never lets a row be claimed a second
   * time. So a `group_added` row must not be claimed AT ALL until push is
   * done, one way or another — claiming it early and deciding on a snapshot
   * of "is there a device right now" would suppress it terminally before push
   * had even tried once. This is the bug CodeRabbit caught on the first pass:
   * every case below sits deliberately in `email_status IS NULL` — untouched,
   * not yet claimed — until push's own state says otherwise.
   */
  describe('group_added — the fallback with nowhere else to land', () => {
    it('leaves it untouched while push has not tried yet, even with a live device', async () => {
      const { profileId, groupId } = await seedPerson({ tokens: 1 });
      const id = await notify(profileId, groupId, 'group_added');

      // Not suppressed — not claimed at all. Deciding anything here, before
      // push has had its first attempt, is exactly the early-suppress bug.
      expect(await claimFor(profileId)).toHaveLength(0);
      expect(await statusOf(id)).toBeNull();
    });

    it('mails it once push (for real, via its own claim) finds no device to try', async () => {
      const { profileId, groupId } = await seedPerson({ tokens: 0 });
      const id = await notify(profileId, groupId, 'group_added');

      // The real pipeline: push's own claim runs first in every fanout call,
      // and it is what turns "no device" into a terminal push_status —
      // group_added's email gate reads that outcome, it does not compute its
      // own. Skipping this step is what made the earlier version of this
      // test pass without the fix in place: it forged a `null` push state
      // rather than the one the no-token branch actually leaves behind.
      //
      // A generous limit, same reasoning as m4-push-fanout.test.ts's `claim`:
      // this suite shares one Postgres with every other file, and the oldest
      // unclaimed rows written by all of them sit ahead of this one.
      await client.query(`SELECT baaki_claim_push_notifications(5000)`);
      expect(await pushStateOf(id)).toEqual({ pushStatus: 'failed', pushNextRetryAt: null });

      expect(await claimFor(profileId)).toHaveLength(1);
    });

    it('leaves it untouched while push still has a retry left, rather than deciding early', async () => {
      const { profileId, groupId } = await seedPerson({ tokens: 1 });
      const id = await notify(profileId, groupId, 'group_added');
      await client.query(
        `UPDATE notifications SET push_status = 'failed', push_attempts = 1,
                                   push_next_retry_at = now() + interval '3 minutes'
          WHERE id = $1`,
        [id],
      );

      expect(await claimFor(profileId)).toHaveLength(0);
      expect(await statusOf(id)).toBeNull();
    });

    it('mails it once push has exhausted all three attempts, even with a live device', async () => {
      const { profileId, groupId } = await seedPerson({ tokens: 1 });
      const id = await notify(profileId, groupId, 'group_added');
      await client.query(
        `UPDATE notifications SET push_status = 'failed', push_attempts = 3,
                                   push_next_retry_at = NULL
          WHERE id = $1`,
        [id],
      );

      expect(await claimFor(profileId)).toHaveLength(1);
    });

    it('suppresses it once push actually succeeds', async () => {
      const { profileId, groupId } = await seedPerson({ tokens: 1 });
      const id = await notify(profileId, groupId, 'group_added');
      await client.query(`UPDATE notifications SET push_status = 'sent' WHERE id = $1`, [id]);

      expect(await claimFor(profileId)).toHaveLength(0);
      expect(await statusOf(id)).toBe('suppressed');
    });
  });
});

describe('two runs at once', () => {
  /**
   * The reason claiming is an UPDATE. Written with real connections rather than
   * `Promise.all` over one client: a single `pg` client serialises its queries,
   * so twenty "concurrent" callers would run one after another and the test
   * would pass while proving nothing.
   */
  it('gives a row to exactly one of ten simultaneous runs', async () => {
    const { profileId, groupId } = await seedPerson();
    await notify(profileId, groupId);

    const clients = await Promise.all(Array.from({ length: 10 }, () => connect()));
    try {
      const counts = await Promise.all(
        clients.map(async (each) => {
          const { rows } = await each.query(
            `SELECT c.id FROM baaki_claim_email_notifications(500) c
               JOIN notifications n ON n.id = c.id
              WHERE n.profile_id = $1`,
            [profileId],
          );
          return rows.length;
        }),
      );
      expect(counts.filter((count) => count === 1)).toHaveLength(1);
      expect(counts.filter((count) => count === 0)).toHaveLength(9);
    } finally {
      await Promise.all(clients.map((each) => each.end()));
    }
  });
});

describe('recording what happened', () => {
  it('marks a send sent and writes down Resend’s id', async () => {
    const { profileId, groupId } = await seedPerson();
    const id = await notify(profileId, groupId);
    await claimFor(profileId);

    await client.query(`SELECT baaki_finish_email($1::jsonb)`, [
      JSON.stringify([
        { id, status: 'sent', resend_email_id: 'resend-abc', template: 'settlement-confirm' },
      ]),
    ]);

    expect(await statusOf(id)).toBe('sent');
    const { rows } = await client.query(
      `SELECT event, resend_email_id, template, profile_id FROM email_events WHERE notification_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('sent');
    expect(rows[0]?.resend_email_id).toBe('resend-abc');
    expect(rows[0]?.profile_id).toBe(profileId);
  });

  it('marks a refusal failed and writes no event', async () => {
    const { profileId, groupId } = await seedPerson();
    const id = await notify(profileId, groupId);
    await claimFor(profileId);

    await client.query(`SELECT baaki_finish_email($1::jsonb)`, [
      JSON.stringify([{ id, status: 'failed', template: 'settlement-confirm' }]),
    ]);

    expect(await statusOf(id)).toBe('failed');
    const { rows } = await client.query(`SELECT 1 FROM email_events WHERE notification_id = $1`, [
      id,
    ]);
    expect(rows).toHaveLength(0);
  });

  /**
   * Resend being rate-limited must not lose a settlement confirmation. 'retry'
   * puts the row back where the next run will find it — which is only true if
   * the status goes back to NULL, because that is the only thing the claim
   * looks at.
   */
  it('puts a transient failure back for the next run', async () => {
    const { profileId, groupId } = await seedPerson();
    const id = await notify(profileId, groupId);
    await claimFor(profileId);

    await client.query(`SELECT baaki_finish_email($1::jsonb)`, [
      JSON.stringify([{ id, status: 'retry', template: 'settlement-confirm' }]),
    ]);

    expect(await statusOf(id)).toBeNull();
    expect(await claimFor(profileId)).toHaveLength(1);
  });

  it('treats a status it does not recognise as a failure, not a success', async () => {
    const { profileId, groupId } = await seedPerson();
    const id = await notify(profileId, groupId);
    await claimFor(profileId);

    await client.query(`SELECT baaki_finish_email($1::jsonb)`, [
      JSON.stringify([{ id, status: 'probably-fine', template: 'settlement-confirm' }]),
    ]);

    expect(await statusOf(id)).toBe('failed');
  });
});

describe('what the webhook does', () => {
  async function sentEmail(): Promise<{ id: string; address: string; resendId: string }> {
    const { profileId, groupId, address } = await seedPerson();
    const id = await notify(profileId, groupId);
    await claimFor(profileId);
    const resendId = `resend-${randomUUID()}`;
    await client.query(`SELECT baaki_finish_email($1::jsonb)`, [
      JSON.stringify([
        { id, status: 'sent', resend_email_id: resendId, template: 'settlement-confirm' },
      ]),
    ]);
    return { id, address, resendId };
  }

  async function record(
    resendId: string,
    event: string,
    address: string,
    payload: unknown = {},
  ): Promise<{ matched: boolean; suppressed: boolean }> {
    const { rows } = await client.query(
      `SELECT baaki_record_email_event($1, $2, $3, $4::jsonb) AS result`,
      [resendId, event, address, JSON.stringify(payload)],
    );
    return rows[0]?.result;
  }

  it('follows a delivery through to the inbox row', async () => {
    const { id, address, resendId } = await sentEmail();
    const result = await record(resendId, 'delivered', address);

    expect(result.matched).toBe(true);
    expect(await statusOf(id)).toBe('delivered');
  });

  it('records an open without pretending it changed the delivery', async () => {
    const { id, address, resendId } = await sentEmail();
    await record(resendId, 'opened', address);

    expect(await statusOf(id)).toBe('sent');
    const { rows } = await client.query(
      `SELECT event FROM email_events WHERE resend_email_id = $1 ORDER BY created_at`,
      [resendId],
    );
    expect(rows.map((row) => row.event)).toEqual(['sent', 'opened']);
  });

  it('suppresses on a complaint, immediately', async () => {
    const { address, resendId } = await sentEmail();
    const result = await record(resendId, 'complained', address);

    expect(result.suppressed).toBe(true);
    const { rows } = await client.query(
      `SELECT reason FROM email_suppressions WHERE address = $1`,
      [address],
    );
    expect(rows[0]?.reason).toBe('complained');
  });

  it('suppresses on a permanent bounce', async () => {
    const { address, resendId } = await sentEmail();
    const result = await record(resendId, 'bounced', address, {
      data: { bounce: { type: 'Permanent' } },
    });

    expect(result.suppressed).toBe(true);
  });

  /** A full mailbox comes back next week. Suppressing it would lose a person. */
  it('does not suppress on a bounce the provider called transient', async () => {
    const { address, resendId } = await sentEmail();
    const result = await record(resendId, 'bounced', address, {
      data: { bounce: { type: 'Transient' } },
    });

    expect(result.suppressed).toBe(false);
    const { rows } = await client.query(`SELECT 1 FROM email_suppressions WHERE address = $1`, [
      address,
    ]);
    expect(rows).toHaveLength(0);
  });

  /**
   * The safer of the two mistakes: one person has to resubscribe, versus a
   * sending domain that keeps mailing dead addresses.
   */
  it('suppresses an unlabelled bounce', async () => {
    const { address, resendId } = await sentEmail();
    expect((await record(resendId, 'bounced', address)).suppressed).toBe(true);
  });

  it('stops the next mail once the address is suppressed', async () => {
    const { profileId, groupId, address } = await seedPerson();
    const first = await notify(profileId, groupId);
    await claimFor(profileId);
    const resendId = `resend-${randomUUID()}`;
    await client.query(`SELECT baaki_finish_email($1::jsonb)`, [
      JSON.stringify([{ id: first, status: 'sent', resend_email_id: resendId, template: 'x' }]),
    ]);
    await record(resendId, 'complained', address);

    const second = await notify(profileId, groupId);
    expect(await claimFor(profileId)).toHaveLength(0);
    expect(await statusOf(second)).toBe('suppressed');
  });

  it('still honours a complaint for an id it never sent', async () => {
    const stranger = `${randomUUID()}@example.com`;
    const result = await record('resend-never-seen', 'complained', stranger);

    expect(result.matched).toBe(false);
    expect(result.suppressed).toBe(true);
  });

  it('keeps the first reason when an address is suppressed twice', async () => {
    const address = `${randomUUID()}@example.com`;
    await client.query(`SELECT baaki_suppress_email($1, 'bounced')`, [address]);
    await client.query(`SELECT baaki_suppress_email($1, 'unsubscribed')`, [address]);

    const { rows } = await client.query(
      `SELECT reason FROM email_suppressions WHERE address = $1`,
      [address],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('bounced');
  });

  it('refuses an event with no name', async () => {
    await expectDenied(client.query(`SELECT baaki_record_email_event('x', '')`));
  });
});

describe('nobody signed in may touch any of it', () => {
  /**
   * The sharpest function in the schema: a profile id is visible to every
   * member of a group, and this turns one into an email address.
   */
  it('will not tell a signed-in caller anybody’s address', async () => {
    const { profileId } = await seedPerson();
    const message = await asRole(client, 'authenticated', { sub: profileId }, () =>
      expectDenied(client.query(`SELECT baaki_email_for($1)`, [profileId])),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('will not let anon read the suppression list', async () => {
    const message = await asRole(client, 'anon', {}, () =>
      expectDenied(client.query(`SELECT * FROM email_suppressions`)),
    );
    expect(message).toMatch(/permission denied/i);
  });

  // One statement per transaction: the first denial aborts it, and a second
  // statement inside would come back "current transaction is aborted", which
  // reads like a pass to a regex looking for the wrong word.
  it('will not let a signed-in caller write to the suppression list', async () => {
    const message = await asRole(client, 'authenticated', {}, () =>
      expectDenied(
        client.query(
          `INSERT INTO email_suppressions (address, reason) VALUES ('a@b.com', 'bounced')`,
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('will not let a signed-in caller unsubscribe somebody else', async () => {
    const message = await asRole(client, 'authenticated', {}, () =>
      expectDenied(
        client.query(`SELECT baaki_suppress_email('victim@example.com', 'unsubscribed')`),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('will not let a signed-in caller claim other people’s mail', async () => {
    const message = await asRole(client, 'authenticated', {}, () =>
      expectDenied(client.query(`SELECT * FROM baaki_claim_email_notifications(1)`)),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('will not let a signed-in caller forge a delivery report', async () => {
    const message = await asRole(client, 'authenticated', {}, () =>
      expectDenied(client.query(`SELECT baaki_record_email_event('x', 'complained', 'a@b.com')`)),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('lets the service role do all of it', async () => {
    const { rows } = await client.query(
      `SELECT has_function_privilege('service_role', 'public.baaki_claim_email_notifications(integer)', 'EXECUTE') AS claim,
              has_function_privilege('service_role', 'public.baaki_record_email_event(text, text, text, jsonb)', 'EXECUTE') AS record,
              has_function_privilege('service_role', 'public.baaki_email_for(uuid)', 'EXECUTE') AS address`,
    );
    expect(rows[0]).toEqual({ claim: true, record: true, address: true });
  });
});

describe('the suppression table itself', () => {
  it('refuses an address that is not already lower-cased', async () => {
    await expectDenied(
      client.query(
        `INSERT INTO email_suppressions (address, reason) VALUES ('A@B.com', 'bounced')`,
      ),
    );
  });

  it('refuses a reason nobody will recognise later', async () => {
    await expectDenied(
      client.query(`INSERT INTO email_suppressions (address, reason) VALUES ('c@d.com', 'vibes')`),
    );
  });

  it('refuses an empty address', async () => {
    await expectDenied(
      client.query(`INSERT INTO email_suppressions (address, reason) VALUES ('', 'bounced')`),
    );
    expect(
      (await client.query(`SELECT baaki_suppress_email('   ', 'bounced') AS ok`)).rows[0]?.ok,
    ).toBe(false);
  });
});
