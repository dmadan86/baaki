/**
 * The broadcast half of A21, checked as SQL.
 *
 * The renderer is tested in `@baaki/core`; nothing here is about what a mail
 * says. What matters here is who a mail is claimed for, and the tests that carry
 * the weight are the refusals: a holdout is never claimed, an unconfirmed or
 * suppressed address is skipped, the same person is never claimed twice, and no
 * client can read the send log or run the claim. A holdout mailed by accident is
 * a control group destroyed, and every revenue number downstream of it is then
 * decoration — so that one is proved, not assumed.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { asRole, connect, expectDenied } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
  // CI runs against bare Postgres, which has no `auth` schema — Supabase owns
  // it, and `baaki_email_for` returns NULL without it, which is correct and also
  // untestable. The same shim `m4-email` uses: the three columns the function
  // reads and nothing else.
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

async function makeProfile(
  options: {
    country?: string | null;
    email?: string | null;
    confirmed?: boolean;
    emailPref?: boolean | null;
  } = {},
): Promise<{ profileId: string; address: string }> {
  const {
    country = 'IN',
    email = `${randomUUID()}@example.com`,
    confirmed = true,
    emailPref = null,
  } = options;

  const id = randomUUID();
  const prefs = emailPref === null ? '{}' : JSON.stringify({ email: emailPref });
  await client.query(
    `INSERT INTO public.profiles (id, display_name, country_code, notification_prefs)
     VALUES ($1, 'Tester', $2, $3::jsonb)`,
    [id, country, prefs],
  );

  if (email) {
    await client.query(
      `INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, $3)`,
      [id, email, confirmed ? new Date().toISOString() : null],
    );
  }

  return { profileId: id, address: email ?? '' };
}

async function makeCampaign(
  over: { holdout?: number; countries?: string[] | null; window?: 'live' | 'ended' } = {},
): Promise<string> {
  const { holdout = 0, countries = null, window = 'live' } = over;
  const [startsAt, endsAt] =
    window === 'ended'
      ? ["now() - interval '9 days'", "now() - interval '3 days'"]
      : ["now() - interval '1 day'", "now() + interval '7 days'"];

  const { rows } = await client.query(
    `INSERT INTO public.campaigns
       (name, title, body, cta_label, promo_code, starts_at, ends_at,
        audience_countries, holdout_percent)
     VALUES ('Test', $2, 'Because you have been here a while',
             'Claim it', NULL, ${startsAt}, ${endsAt}, $3, $1)
     RETURNING id`,
    [holdout, `Offer ${randomUUID().slice(0, 8)}`, countries],
  );
  return rows[0].id;
}

// A high limit on purpose: this database persists between local runs, so earlier
// runs leave email-having profiles that are legitimately eligible for a fresh
// campaign. A small limit would truncate the batch and drop the profile the test
// just made. In production the edge function caps itself; here we want everyone.
async function claim(campaignId: string, limit = 100_000) {
  const { rows } = await client.query('SELECT * FROM public.baaki_claim_campaign_emails($1, $2)', [
    campaignId,
    limit,
  ]);
  return rows as Array<{ send_id: string; address: string; title: string; cta_label: string }>;
}

async function finish(results: unknown[]): Promise<void> {
  await client.query('SELECT public.baaki_finish_campaign_emails($1::jsonb)', [
    JSON.stringify(results),
  ]);
}

async function cohort(campaignId: string, profileId: string): Promise<string> {
  const { rows } = await client.query('SELECT public.baaki_campaign_cohort($1, $2) AS c', [
    campaignId,
    profileId,
  ]);
  return rows[0].c;
}

describe('who a campaign is claimed for', () => {
  it('claims a targeted member with a confirmed address, and hands over the words', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const { profileId, address } = await makeProfile();

    const rows = await claim(campaignId);
    const mine = rows.find((row) => row.address === address);
    expect(mine).toBeDefined();
    expect(mine?.title).toMatch(/^Offer /);
    expect(mine?.cta_label).toBe('Claim it');
    expect(profileId).toBeTruthy();
  });

  it('never claims a holdout', async () => {
    const campaignId = await makeCampaign({ holdout: 90 });
    const held: string[] = [];
    const addresses: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const person = await makeProfile();
      if ((await cohort(campaignId, person.profileId)) === 'holdout') {
        held.push(person.profileId);
        addresses.push(person.address);
      }
    }
    expect(held.length).toBeGreaterThan(0);

    const claimed = new Set((await claim(campaignId)).map((row) => row.address));
    for (const address of addresses) expect(claimed.has(address)).toBe(false);
  });

  it('skips no address, an unconfirmed address, email turned off, and a suppressed address', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const none = await makeProfile({ email: null });
    const unconfirmed = await makeProfile({ confirmed: false });
    const optedOut = await makeProfile({ emailPref: false });
    const suppressed = await makeProfile();
    await client.query(`SELECT public.baaki_suppress_email($1, 'bounced')`, [suppressed.address]);
    const ok = await makeProfile();

    const claimed = new Set((await claim(campaignId)).map((row) => row.address));
    expect(claimed.has(ok.address)).toBe(true);
    expect(claimed.has(unconfirmed.address)).toBe(false);
    expect(claimed.has(optedOut.address)).toBe(false);
    expect(claimed.has(suppressed.address)).toBe(false);
    // No address means nothing to check, only that the person is not in the set.
    expect([...claimed].every((address) => address !== none.address)).toBe(true);
  });

  it('respects the country the campaign is aimed at', async () => {
    const campaignId = await makeCampaign({ holdout: 0, countries: ['AE'] });
    const indian = await makeProfile({ country: 'IN' });
    const emirati = await makeProfile({ country: 'AE' });

    const claimed = new Set((await claim(campaignId)).map((row) => row.address));
    expect(claimed.has(emirati.address)).toBe(true);
    expect(claimed.has(indian.address)).toBe(false);
  });

  it('claims nobody for a campaign that is not running', async () => {
    const campaignId = await makeCampaign({ holdout: 0, window: 'ended' });
    await makeProfile();
    expect(await claim(campaignId)).toHaveLength(0);
  });
});

describe('sending each person exactly once', () => {
  it('does not claim the same person twice across two runs', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const { address } = await makeProfile();

    const first = await claim(campaignId);
    const mine = first.find((row) => row.address === address);
    expect(mine).toBeDefined();
    await finish([{ id: mine!.send_id, status: 'sent', resend_email_id: 're_1' }]);

    const second = await claim(campaignId);
    expect(second.some((row) => row.address === address)).toBe(false);
  });

  it('records a sent as an email_events row, so a later bounce can be matched back', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const person = await makeProfile();
    const mine = (await claim(campaignId)).find((row) => row.address === person.address)!;
    // Unique per run — this database persists locally, and a fixed id would
    // match rows an earlier run left behind.
    const resendId = `re_${randomUUID()}`;

    await finish([{ id: mine.send_id, status: 'sent', resend_email_id: resendId }]);

    const send = await client.query(
      'SELECT status, resend_email_id FROM public.campaign_email_sends WHERE id = $1',
      [mine.send_id],
    );
    expect(send.rows[0].status).toBe('sent');
    expect(send.rows[0].resend_email_id).toBe(resendId);

    const event = await client.query(
      `SELECT profile_id, template, event, notification_id
         FROM public.email_events WHERE resend_email_id = $1`,
      [resendId],
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].profile_id).toBe(person.profileId);
    expect(event.rows[0].template).toBe('campaign');
    expect(event.rows[0].event).toBe('sent');
    // A campaign has no notification row; the webhook match works on NULL.
    expect(event.rows[0].notification_id).toBeNull();
  });

  it('re-claims somebody whose send was transient, because retry drops the claim', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const { address } = await makeProfile();

    const mine = (await claim(campaignId)).find((row) => row.address === address)!;
    await finish([{ id: mine.send_id, status: 'retry', error: '429 rate limited' }]);

    // The row is gone, so the next run picks the person up again.
    const again = await claim(campaignId);
    expect(again.some((row) => row.address === address)).toBe(true);
  });

  it('does not re-claim a permanent failure', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const { address } = await makeProfile();

    const mine = (await claim(campaignId)).find((row) => row.address === address)!;
    await finish([{ id: mine.send_id, status: 'failed', error: '422 invalid' }]);

    const again = await claim(campaignId);
    expect(again.some((row) => row.address === address)).toBe(false);
  });
});

describe('what a client may not do', () => {
  it('cannot read the send log', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await asRole(client, role, { role }, () =>
        expectDenied(client.query('SELECT * FROM public.campaign_email_sends')),
      );
      expect(message, role).toMatch(/permission denied/i);
    }
  });

  it('cannot claim or finish a broadcast, or read its stats', async () => {
    const calls: Array<[string, unknown[]]> = [
      ['SELECT public.baaki_claim_campaign_emails($1, 10)', [randomUUID()]],
      ['SELECT public.baaki_finish_campaign_emails($1::jsonb)', ['[]']],
      ['SELECT * FROM public.baaki_admin_campaign_email_stats($1)', [randomUUID()]],
    ];

    for (const role of ['anon', 'authenticated'] as const) {
      for (const [sql, args] of calls) {
        const message = await asRole(client, role, { role }, () =>
          expectDenied(client.query(sql, args)),
        );
        expect(message, `${role}: ${sql}`).toMatch(/permission denied/i);
      }
    }
  });
});
