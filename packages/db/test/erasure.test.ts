/**
 * Leaving, and what leaving must not take with it.
 *
 * The test this file exists for is the balance one. Asha's expenses are also
 * Ravi's records — they are what says he owes ₹4,500 — so an erasure that
 * removed them would silently settle a debt nobody paid. Every other assertion
 * here is secondary to that one.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, big, connect, expectDenied, seedGroup } from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/** Session-scoped claims: erasure is a write, so a rolled-back role will not do. */
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

async function balances(groupId: string): Promise<Map<string, bigint>> {
  const { rows } = await client.query(
    'SELECT member_id, balance FROM public.group_balances WHERE group_id = $1',
    [groupId],
  );
  return new Map(rows.map((row) => [row.member_id as string, big(row.balance)]));
}

describe('the schema refuses a naive delete', () => {
  it('will not let a profile in a group simply disappear', async () => {
    // Not a limitation to work around — the check is the schema saying a
    // membership cannot stop referring to somebody without becoming a
    // reference to somebody else. It is why erasure converts to a ghost.
    const { profileIds } = await seedGroup(client, { memberCount: 2 });
    const message = await expectDenied(
      client.query('DELETE FROM public.profiles WHERE id = $1', [profileIds[0]]),
    );
    expect(message).toMatch(/group_members_profile_xor_ghost/);
  });
});

describe('erasing an account', () => {
  it('leaves every other person’s balance exactly where it was', async () => {
    const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 3 });
    const [asha, ravi] = memberIds as [string, string, string];

    // Asha pays for dinner; all three owe her a share.
    await addEqualSplitExpense(client, {
      groupId,
      payers: { [asha]: 45_000n },
      participants: memberIds,
      amount: 45_000n,
    });

    const before = await balances(groupId);
    const raviBefore = before.get(ravi);
    expect(raviBefore).toBeDefined();
    expect(raviBefore).not.toBe(0n);

    await asProfile(profileIds[0]!, () =>
      client.query('SELECT public.baaki_delete_my_account($1)', ['Leaving, thanks']),
    );

    const after = await balances(groupId);
    // The whole point, stated twice: what Ravi owes is unchanged, and the sum
    // still cancels (ADR-004's invariant).
    expect(after.get(ravi)).toBe(raviBefore);
    const total = [...after.values()].reduce((sum, value) => sum + value, 0n);
    expect(total).toBe(0n);
  });

  it('turns the membership into a ghost rather than removing it', async () => {
    const { groupId, profileIds } = await seedGroup(client, { memberCount: 2 });
    const countBefore = await client.query(
      'SELECT count(*)::int AS n FROM public.group_members WHERE group_id = $1',
      [groupId],
    );

    await asProfile(profileIds[0]!, () => client.query('SELECT public.baaki_delete_my_account()'));

    const countAfter = await client.query(
      'SELECT count(*)::int AS n FROM public.group_members WHERE group_id = $1',
      [groupId],
    );
    expect(countAfter.rows[0].n).toBe(countBefore.rows[0].n);

    const { rows } = await client.query(
      `SELECT profile_id, ghost_name, payment_handle, invite_email, invite_phone
         FROM public.group_members WHERE group_id = $1 AND ghost_name IS NOT NULL`,
      [groupId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].profile_id).toBeNull();
    expect(rows[0].ghost_name).toBe('Former member');
    // The contact hints go too — they are the person, not the ledger.
    expect(rows[0].payment_handle).toBeNull();
    expect(rows[0].invite_email).toBeNull();
    expect(rows[0].invite_phone).toBeNull();
  });

  it('takes the profile and everything personal hanging off it', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 2 });
    const profileId = profileIds[0]!;

    await client.query(
      `INSERT INTO public.push_tokens (profile_id, expo_push_token, platform)
       VALUES ($1, $2, 'android')`,
      [profileId, `token-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO public.subscriptions
         (profile_id, tier, period, status, current_period_end, store, store_txn_id)
       VALUES ($1, 'plus', 'monthly', 'active', now() + interval '30 days', 'promo', $2)`,
      [profileId, `promo:erasure:${profileId}`],
    );

    await asProfile(profileId, () => client.query('SELECT public.baaki_delete_my_account()'));

    for (const table of ['profiles', 'push_tokens', 'subscriptions']) {
      const column = table === 'profiles' ? 'id' : 'profile_id';
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM public.${table} WHERE ${column} = $1`,
        [profileId],
      );
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('keeps the parting words after the account is gone', async () => {
    // The reason the foreign key is SET NULL rather than CASCADE. Why somebody
    // left is the most useful thing they ever write, and cascading it away at
    // the moment of deletion would destroy precisely that.
    const { profileIds } = await seedGroup(client, { memberCount: 2 });
    const profileId = profileIds[0]!;
    const words = `Too many notifications ${randomUUID().slice(0, 8)}`;

    await asProfile(profileId, () =>
      client.query('SELECT public.baaki_delete_my_account($1)', [words]),
    );

    const { rows } = await client.query(
      'SELECT profile_id, kind, message FROM public.feedback WHERE message = $1',
      [words],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('deletion');
    expect(rows[0].profile_id).toBeNull();
  });

  it('tells somebody what it will cost before they agree to it', async () => {
    const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 2 });
    await addEqualSplitExpense(client, {
      groupId,
      payers: { [memberIds[0]!]: 20_000n },
      participants: memberIds,
      amount: 20_000n,
    });

    const { rows } = await asProfile(profileIds[0]!, async () =>
      client.query('SELECT * FROM public.baaki_my_erasure_preview()'),
    );
    expect(Number(rows[0].groups_count)).toBeGreaterThanOrEqual(1);
    expect(Number(rows[0].expenses_authored)).toBeGreaterThanOrEqual(1);
    expect(rows[0].outstanding_currencies).toContain('INR');
  });

  it('refuses when nobody is signed in', async () => {
    const message = await expectDenied(
      client.query('SELECT public.baaki_delete_my_account($1)', ['nope']),
    );
    expect(message).toMatch(/NOT_SIGNED_IN/);
  });
});

describe('feedback', () => {
  it('stamps the author rather than trusting the caller', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 2 });
    const message = `Lovely app ${randomUUID().slice(0, 8)}`;

    await asProfile(profileIds[0]!, () =>
      client.query('SELECT public.baaki_submit_feedback($1, $2, $3)', [message, 'idea', 5]),
    );

    const { rows } = await client.query('SELECT * FROM public.feedback WHERE message = $1', [
      message,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].profile_id).toBe(profileIds[0]);
    expect(rows[0].rating).toBe(5);
  });

  it('refuses an empty message and an unknown kind', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 1 });
    await asProfile(profileIds[0]!, async () => {
      expect(
        await expectDenied(client.query('SELECT public.baaki_submit_feedback($1)', ['   '])),
      ).toMatch(/EMPTY_MESSAGE/);
      expect(
        await expectDenied(
          client.query('SELECT public.baaki_submit_feedback($1, $2)', ['hi', 'rubbish']),
        ),
      ).toMatch(/feedback_kind_known/);
    });
  });

  it('does not let a client write or read somebody else’s', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 2 });
    const mine = profileIds[0]!;
    const theirs = profileIds[1]!;
    const secret = `Private note ${randomUUID().slice(0, 8)}`;

    await asProfile(theirs, () =>
      client.query('SELECT public.baaki_submit_feedback($1)', [secret]),
    );

    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: mine, role: 'authenticated' }),
      ]);
      await client.query('SET LOCAL ROLE authenticated');

      // A savepoint around the denial. A failed statement poisons the whole
      // transaction — every later command comes back "current transaction is
      // aborted" — so without this the read below fails for a reason that has
      // nothing to do with what it is checking.
      await client.query('SAVEPOINT probe');
      const insert = await expectDenied(
        client.query(`INSERT INTO public.feedback (profile_id, message) VALUES ($1, 'forged')`, [
          theirs,
        ]),
      );
      expect(insert).toMatch(/permission denied/i);
      await client.query('ROLLBACK TO SAVEPOINT probe');

      const { rows } = await client.query('SELECT * FROM public.feedback WHERE message = $1', [
        secret,
      ]);
      expect(rows).toHaveLength(0);
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
          client.query('SELECT * FROM public.baaki_admin_feedback(10)'),
        );
        expect(message, role).toMatch(/permission denied/i);
      } finally {
        await client.query('ROLLBACK');
      }
    }
  });
});
