/**
 * Campaigns, and the holdout that makes "did it work" answerable.
 *
 * The tests that matter most here are not about arithmetic. They are that a
 * client cannot read the campaigns table, cannot ask which cohort it is in, and
 * that somebody held out never receives the announcement. A holdout who learns
 * they are a holdout has stopped being a control group, and every number
 * downstream of that is decoration.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { asRole, connect, expectDenied } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function makeProfile(country: string | null = 'IN'): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.profiles (id, display_name, country_code) VALUES ($1, 'Tester', $2)`,
    [id, country],
  );
  return id;
}

async function makeCampaign(
  over: {
    holdout?: number;
    countries?: string[] | null;
    startsAt?: string;
    endsAt?: string;
    promoCode?: string | null;
  } = {},
): Promise<string> {
  const {
    holdout = 10,
    countries = null,
    startsAt = "now() - interval '1 day'",
    endsAt = "now() + interval '7 days'",
    promoCode = null,
  } = over;

  // A unique title per campaign. Every test in this file leaves running
  // campaigns behind, and `baaki_my_campaign` legitimately answers with any one
  // of them — so asserting on a shared title matches the wrong row and the
  // test passes or fails for reasons that have nothing to do with its subject.
  const { rows } = await client.query(
    `INSERT INTO public.campaigns
       (name, title, body, cta_label, promo_code, starts_at, ends_at,
        audience_countries, holdout_percent)
     VALUES ('Test', $4, 'Because you have been here a while',
             'Get it', $1, ${startsAt}, ${endsAt}, $2, $3)
     RETURNING id`,
    [promoCode, countries, holdout, `Offer ${randomUUID().slice(0, 8)}`],
  );
  return rows[0].id;
}

/** Total revenue the function reports right now, across every cohort. */
async function totalRevenue(campaignId: string): Promise<number> {
  const { rows } = await client.query('SELECT * FROM public.baaki_admin_campaign_revenue($1)', [
    campaignId,
  ]);
  return rows.reduce((sum, row) => sum + Number(row.revenue_minor), 0);
}

/** What the app sees, as the app sees it. Read-only, so a rollback is fine. */
async function myCampaign(profileId: string) {
  return asRole(client, 'authenticated', { sub: profileId, role: 'authenticated' }, async () => {
    const { rows } = await client.query('SELECT * FROM public.baaki_my_campaign()');
    return rows;
  });
}

/**
 * The same identity, but for a call that has to persist.
 *
 * `asRole` ends in ROLLBACK — that is how it puts the connection back — so
 * anything written through it is discarded the moment it returns. Recording an
 * impression is a write, so the claim is set at session scope instead and the
 * statement runs outside a transaction of the helper's making.
 */
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

describe('the holdout', () => {
  it('splits the audience at roughly the percentage asked for', async () => {
    const campaignId = await makeCampaign({ holdout: 30 });
    const people = Array.from({ length: 400 }, () => randomUUID());

    const { rows } = await client.query(
      `SELECT public.baaki_campaign_cohort($1, p::uuid) AS cohort FROM unnest($2::uuid[]) AS p`,
      [campaignId, people],
    );
    const held = rows.filter((row) => row.cohort === 'holdout').length;

    // 30% ± 8 points over 400 draws. Wide enough not to flake, tight enough to
    // catch a bucketer that ignores the percentage.
    expect(held / rows.length).toBeGreaterThan(0.22);
    expect(held / rows.length).toBeLessThan(0.38);
  });

  it('gives the same person the same cohort every time', async () => {
    const campaignId = await makeCampaign({ holdout: 50 });
    const profileId = randomUUID();
    const once = await client.query('SELECT public.baaki_campaign_cohort($1, $2) AS c', [
      campaignId,
      profileId,
    ]);
    const twice = await client.query('SELECT public.baaki_campaign_cohort($1, $2) AS c', [
      campaignId,
      profileId,
    ]);
    expect(once.rows[0].c).toBe(twice.rows[0].c);
  });

  it('does not hold the same people out of every campaign', async () => {
    // Hashing on the campaign id rather than a per-person flag. Otherwise the
    // same unlucky cohort is never told anything and every later result is
    // measured against people who have been ignored for months.
    const first = await makeCampaign({ holdout: 50 });
    const second = await makeCampaign({ holdout: 50 });
    const people = Array.from({ length: 300 }, () => randomUUID());

    const { rows } = await client.query(
      `SELECT p::uuid AS id,
              public.baaki_campaign_cohort($1, p::uuid) AS a,
              public.baaki_campaign_cohort($2, p::uuid) AS b
         FROM unnest($3::uuid[]) AS p`,
      [first, second, people],
    );
    const moved = rows.filter((row) => row.a !== row.b).length;
    // Independent hashes: about half should differ. Zero would mean one shared
    // bucket, which is the bug.
    expect(moved).toBeGreaterThan(rows.length * 0.3);
  });
});

describe('what the app is shown', () => {
  it('offers a running campaign to a targeted person', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const profileId = await makeProfile('IN');

    const rows = await myCampaign(profileId);
    expect(rows.map((row) => row.id)).toContain(campaignId);
    // The announcement's own words come back, not an id the app would have to
    // look up somewhere it has no access to.
    const offered = rows.find((row) => row.id === campaignId);
    expect(offered?.title).toMatch(/^Offer /);
    expect(offered?.cta_label).toBe('Get it');
  });

  it('never offers it to somebody held out', async () => {
    const campaignId = await makeCampaign({ holdout: 90 });
    const held: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const profileId = await makeProfile('IN');
      const cohort = await client.query('SELECT public.baaki_campaign_cohort($1, $2) AS cohort', [
        campaignId,
        profileId,
      ]);
      if (cohort.rows[0].cohort === 'holdout') held.push(profileId);
    }
    expect(held.length).toBeGreaterThan(0);

    // Specifically this campaign. They may well be offered another one that is
    // also running, and that is correct behaviour rather than a leak.
    for (const profileId of held) {
      const rows = await myCampaign(profileId);
      expect(
        rows.map((row) => row.id),
        profileId,
      ).not.toContain(campaignId);
    }
  });

  it('respects the country the campaign is aimed at', async () => {
    const campaignId = await makeCampaign({ holdout: 0, countries: ['AE'] });
    const indian = await makeProfile('IN');
    const emirati = await makeProfile('AE');

    expect((await myCampaign(indian)).map((row) => row.id)).not.toContain(campaignId);
    expect((await myCampaign(emirati)).map((row) => row.id)).toContain(campaignId);
  });

  it('does not offer one that has not started or has ended', async () => {
    const profileId = await makeProfile('IN');
    const before = await myCampaign(profileId);

    await makeCampaign({
      holdout: 0,
      startsAt: "now() + interval '3 days'",
      endsAt: "now() + interval '9 days'",
    });
    await makeCampaign({
      holdout: 0,
      startsAt: "now() - interval '9 days'",
      endsAt: "now() - interval '3 days'",
    });

    expect(await myCampaign(profileId)).toHaveLength(before.length);
  });

  it('stops offering it once it has been seen', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const profileId = await makeProfile('IN');

    expect((await myCampaign(profileId)).some((row) => row.id === campaignId)).toBe(true);

    await asProfile(profileId, () =>
      client.query('SELECT public.baaki_campaign_seen($1, $2)', [campaignId, false]),
    );

    expect((await myCampaign(profileId)).some((row) => row.id === campaignId)).toBe(false);
  });

  it('records one impression however many times it is reported', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const profileId = await makeProfile('IN');

    for (const acted of [false, true, false]) {
      await asProfile(profileId, () =>
        client.query('SELECT public.baaki_campaign_seen($1, $2)', [campaignId, acted]),
      );
    }

    const { rows } = await client.query(
      'SELECT * FROM public.campaign_impressions WHERE campaign_id = $1 AND profile_id = $2',
      [campaignId, profileId],
    );
    expect(rows).toHaveLength(1);
    // Having acted once is not undone by a later dismissal.
    expect(rows[0].acted_at).not.toBeNull();
  });
});

describe('what a client may not do', () => {
  it('cannot read the campaigns table', async () => {
    // It would expose campaigns aimed elsewhere, campaigns not yet started, and
    // the reader's own holdout status.
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await asRole(client, role, { role }, () =>
        expectDenied(client.query('SELECT * FROM public.campaigns')),
      );
      expect(message, role).toMatch(/permission denied/i);
    }
  });

  it('cannot ask which cohort it is in', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await asRole(client, role, { role }, () =>
        expectDenied(
          client.query('SELECT public.baaki_campaign_cohort($1, $2)', [randomUUID(), randomUUID()]),
        ),
      );
      expect(message, role).toMatch(/permission denied/i);
    }
  });

  it('cannot read the results', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await asRole(client, role, { role }, () =>
        expectDenied(
          client.query('SELECT * FROM public.baaki_admin_campaign_funnel($1)', [randomUUID()]),
        ),
      );
      expect(message, role).toMatch(/permission denied/i);
    }
  });

  it('cannot write an impression for somebody else', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const mine = await makeProfile('IN');
    const theirs = await makeProfile('IN');

    const message = await asRole(
      client,
      'authenticated',
      { sub: mine, role: 'authenticated' },
      () =>
        expectDenied(
          client.query(
            'INSERT INTO public.campaign_impressions (campaign_id, profile_id) VALUES ($1, $2)',
            [campaignId, theirs],
          ),
        ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe('did it work', () => {
  it('counts a comped subscription as a grant, never as revenue', async () => {
    // The distinction the whole feature turns on. A promo row has no price and
    // must not appear as money earned, or every campaign reports as a triumph.
    // Unique per run: this database is disposable in CI but persists locally,
    // and a fixed code collides with itself the second time.
    const code = `T${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`;
    await client.query(
      `INSERT INTO public.promo_codes (code, days, max_redemptions) VALUES ($1, 30, 100)`,
      [code],
    );
    const campaignId = await makeCampaign({ holdout: 0, promoCode: code });
    const profileId = await makeProfile('IN');

    // Before and after, rather than an absolute: other tests in this file leave
    // real purchases behind, and the claim being made is only that *this* row
    // adds nothing.
    const before = await totalRevenue(campaignId);

    await client.query(
      `INSERT INTO public.subscriptions
         (profile_id, tier, period, status, current_period_end, store, store_txn_id)
       VALUES ($1, 'plus', 'monthly', 'active', now() + interval '30 days', 'promo', $2)`,
      [profileId, `promo:${code}:${profileId}`],
    );

    expect(await totalRevenue(campaignId)).toBe(before);
  });

  it('counts a real purchase as revenue, per currency', async () => {
    const campaignId = await makeCampaign({ holdout: 0 });
    const profileId = await makeProfile('IN');

    await client.query(
      `INSERT INTO public.subscriptions
         (profile_id, tier, period, status, current_period_end, store, store_txn_id,
          price_minor, currency)
       VALUES ($1, 'plus', 'monthly', 'active', now() + interval '30 days', 'play', $2, 9900, 'INR')`,
      [profileId, `play:${profileId}`],
    );

    const { rows } = await client.query('SELECT * FROM public.baaki_admin_campaign_revenue($1)', [
      campaignId,
    ]);
    const inr = rows.find((row) => row.currency === 'INR');
    expect(inr).toBeDefined();
    expect(Number(inr!.revenue_minor)).toBeGreaterThanOrEqual(9900);
    expect(rows.every((row) => ['targeted', 'holdout'].includes(row.cohort))).toBe(true);
  });

  it('reports a funnel split by cohort', async () => {
    const campaignId = await makeCampaign({ holdout: 40 });
    for (let index = 0; index < 30; index += 1) await makeProfile('IN');

    const { rows } = await client.query('SELECT * FROM public.baaki_admin_campaign_funnel($1)', [
      campaignId,
    ]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['targeted', 'holdout']).toContain(row.cohort);
      // Nobody can have been seen more times than there are people in the arm.
      expect(Number(row.seen)).toBeLessThanOrEqual(Number(row.people));
      expect(Number(row.redeemed)).toBeLessThanOrEqual(Number(row.people));
      expect(Number(row.paid)).toBeLessThanOrEqual(Number(row.people));
    }
  });
});
