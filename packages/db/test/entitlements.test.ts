/**
 * Who has paid for what.
 *
 * Two things worth pinning. The first is the resolution itself — grace is still
 * paid, an expired row is not, a lifetime purchase outranks a subscription, and
 * a trip pass covers everybody in the group rather than only the buyer.
 *
 * The second is that **a client cannot grant itself any of it**. That is the
 * rule the security audit left behind: a paywall a phone can write around is a
 * paywall with a door in the back, and it is the same shape of bug as the
 * settlement anybody could mark confirmed.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied, seedGroup, type SeededGroup } from './helpers';

let client: Client;
let group: SeededGroup;

beforeAll(async () => {
  client = await connect();
  group = await seedGroup(client, { memberCount: 2, name: 'Goa' });
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query(`DELETE FROM subscriptions WHERE profile_id = ANY($1::uuid[])`, [
    group.profileIds,
  ]);
  await client.query(`DELETE FROM group_passes WHERE group_id = $1`, [group.groupId]);
});

/** Run as the first member, the way PostgREST would. */
async function asMe<T>(run: () => Promise<T>, profileId = group.profileIds[0]): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: profileId, role: 'authenticated' }),
    ]);
    await client.query('SET LOCAL ROLE authenticated');
    return await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function plan(profileId = group.profileIds[0]): Promise<Record<string, unknown>> {
  return asMe(async () => {
    const { rows } = await client.query(`SELECT baaki_my_plan() AS plan`);
    return rows[0].plan as Record<string, unknown>;
  }, profileId);
}

async function grant(fields: {
  period: string;
  status?: string;
  endsIn?: string | null;
  profileId?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO subscriptions (profile_id, tier, period, status, current_period_end, store)
     VALUES ($1, 'plus', $2, $3,
             CASE WHEN $4::text IS NULL THEN NULL ELSE now() + $4::interval END,
             'play')`,
    [
      fields.profileId ?? group.profileIds[0],
      fields.period,
      fields.status ?? 'active',
      fields.period === 'lifetime' ? null : (fields.endsIn ?? '30 days'),
    ],
  );
}

describe('what somebody is entitled to', () => {
  it('is free when they have never paid', async () => {
    const result = await plan();
    expect(result.tier).toBe('free');
    expect(result.source).toBe('free');
    expect(result.scanLimit).toBe(20);
  });

  it('is plus while a subscription runs', async () => {
    await grant({ period: 'monthly' });
    const result = await plan();
    expect(result.tier).toBe('plus');
    expect(result.source).toBe('subscription');
    expect(result.scanLimit).toBe(300);
  });

  it('stays plus during the store’s grace period', async () => {
    // The store is retrying a card. Taking the features away mid-retry
    // punishes somebody whose bank was slow, not somebody who stopped paying.
    await grant({ period: 'monthly', status: 'grace' });
    expect((await plan()).tier).toBe('plus');
  });

  it('is free again once it has expired', async () => {
    await grant({ period: 'monthly', endsIn: '-1 day' });
    expect((await plan()).tier).toBe('free');
  });

  it('is free after a refund or a cancellation, whatever the dates say', async () => {
    for (const status of ['expired', 'cancelled', 'refunded']) {
      await client.query(`DELETE FROM subscriptions WHERE profile_id = $1`, [group.profileIds[0]]);
      await grant({ period: 'yearly', status });
      expect((await plan()).tier, status).toBe('free');
    }
  });

  it('never lapses on a lifetime purchase', async () => {
    await grant({ period: 'lifetime' });
    const result = await plan();
    expect(result.tier).toBe('plus');
    expect(result.source).toBe('lifetime');
    expect(result.until).toBeNull();
  });

  it('prefers the lifetime purchase when somebody has both', async () => {
    await grant({ period: 'monthly' });
    await grant({ period: 'lifetime' });
    expect((await plan()).source).toBe('lifetime');
  });

  it('is one person’s answer, not another’s', async () => {
    await grant({ period: 'yearly' });
    expect((await plan(group.profileIds[0])).tier).toBe('plus');
    expect((await plan(group.profileIds[1])).tier).toBe('free');
  });

  it('refuses a subscription that ends nowhere and is not lifetime', async () => {
    // The constraint exists so a row cannot claim to be a monthly plan that
    // never expires — which would be a lifetime purchase somebody got for the
    // price of a month.
    await expect(
      client.query(
        `INSERT INTO subscriptions (profile_id, tier, period, status, current_period_end, store)
         VALUES ($1, 'plus', 'monthly', 'active', NULL, 'play')`,
        [group.profileIds[0]],
      ),
    ).rejects.toThrow(/subscriptions_end_matches_period|violates/i);
  });

  it('records the same store purchase only once', async () => {
    // Both stores replay their webhooks, deliberately and often.
    const txn = `GPA.${randomUUID()}`;
    const insert = `INSERT INTO subscriptions
       (profile_id, tier, period, status, current_period_end, store, store_txn_id)
       VALUES ($1, 'plus', 'monthly', 'active', now() + interval '30 days', 'play', $2)`;
    await client.query(insert, [group.profileIds[0], txn]);
    await expect(client.query(insert, [group.profileIds[0], txn])).rejects.toThrow(
      /store_txn_id|unique/i,
    );
  });
});

describe('a pass bought for the whole group', () => {
  async function buyPass(days = 30): Promise<void> {
    await client.query(
      `INSERT INTO group_passes (group_id, purchased_by, expires_at, store)
       VALUES ($1, $2, now() + ($3 || ' days')::interval, 'play')`,
      [group.groupId, group.profileIds[0], String(days)],
    );
  }

  async function groupPlan(profileId: string): Promise<Record<string, unknown>> {
    return asMe(async () => {
      const { rows } = await client.query(`SELECT baaki_group_plan($1) AS plan`, [group.groupId]);
      return rows[0].plan as Record<string, unknown>;
    }, profileId);
  }

  it('covers somebody who did not buy it', async () => {
    // The whole point: the buyer is being generous rather than out of pocket,
    // and five people who did not pay see what the paid tier does.
    await buyPass();
    const theirs = await groupPlan(group.profileIds[1] as string);
    expect(theirs.tier).toBe('plus');
    expect(theirs.source).toBe('trip_pass');
  });

  it('does not follow them into another group', async () => {
    await buyPass();
    const other = await seedGroup(client, { memberCount: 1, name: 'Elsewhere' });
    await client.query(
      `INSERT INTO group_members (group_id, profile_id, role, joined_via)
       VALUES ($1, $2, 'member', 'invite')`,
      [other.groupId, group.profileIds[1]],
    );
    const result = await asMe(async () => {
      const { rows } = await client.query(`SELECT baaki_group_plan($1) AS plan`, [other.groupId]);
      return rows[0].plan as Record<string, unknown>;
    }, group.profileIds[1]);
    expect(result.tier).toBe('free');
  });

  it('stops covering anybody once it runs out', async () => {
    await buyPass(-1);
    expect((await groupPlan(group.profileIds[1] as string)).tier).toBe('free');
  });

  it('does not answer for a group the caller is not in', async () => {
    const outsider = randomUUID();
    await client.query(
      `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'Mallory', 'INR')`,
      [outsider],
    );
    await asMe(async () => {
      const message = await expectDenied(
        client.query(`SELECT baaki_group_plan($1)`, [group.groupId]),
      );
      expect(message).toMatch(/NOT_A_MEMBER/);
    }, outsider);
  });
});

describe('the scan quota reads the plan', () => {
  it('gives twenty away and three hundred to a subscriber', async () => {
    // The number used to be hardcoded twice — once here and once in
    // `receipt-parse` — which is two places to forget.
    const free = await asMe(async () => {
      const { rows } = await client.query(`SELECT baaki_receipt_scan_quota() AS q`);
      return rows[0].q as Record<string, unknown>;
    });
    expect(free.limit).toBe(20);
    expect(free.tier).toBe('free');

    await grant({ period: 'yearly' });
    const paid = await asMe(async () => {
      const { rows } = await client.query(`SELECT baaki_receipt_scan_quota() AS q`);
      return rows[0].q as Record<string, unknown>;
    });
    expect(paid.limit).toBe(300);
    expect(paid.tier).toBe('plus');
  });
});

describe('nobody buys themselves a subscription', () => {
  it('refuses a client writing its own subscription row', async () => {
    // A paywall a phone can write around is a paywall with a door in the back.
    await asMe(async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO subscriptions (profile_id, tier, period, status, current_period_end, store)
           VALUES ($1, 'plus', 'lifetime', 'active', NULL, 'promo')`,
          [group.profileIds[0]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses a client extending one it already has', async () => {
    await grant({ period: 'monthly' });
    await asMe(async () => {
      const message = await expectDenied(
        client.query(`UPDATE subscriptions SET period = 'lifetime', current_period_end = NULL`),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('refuses a client writing itself a trip pass', async () => {
    await asMe(async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO group_passes (group_id, purchased_by, expires_at)
           VALUES ($1, $2, now() + interval '365 days')`,
          [group.groupId, group.profileIds[0]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('still lets somebody read what they have', async () => {
    await grant({ period: 'monthly' });
    const seen = await asMe(async () => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM subscriptions`);
      return rows[0].n as number;
    });
    expect(seen).toBe(1);
  });

  it('does not let them read somebody else’s', async () => {
    await grant({ period: 'monthly', profileId: group.profileIds[0] });
    const seen = await asMe(async () => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM subscriptions`);
      return rows[0].n as number;
    }, group.profileIds[1]);
    expect(seen).toBe(0);
  });
});
