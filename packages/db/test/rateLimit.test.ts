/**
 * The rate limiter, against a real Postgres.
 *
 * Two things are worth proving and neither can be proved by reading the SQL:
 * that the count is atomic under concurrency, and that no client role can reach
 * either the table or the function. The rest — windows rolling over, the
 * arithmetic of `retryAfter` — is cheap to check and would otherwise be found
 * in production by somebody who could not get in.
 */

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asRole, connect, expectDenied } from './helpers';

let client: Client;

/** A subject nobody else in this file is using, so tests cannot collide. */
function subject(): string {
  return `test:${randomUUID()}`;
}

interface Decision {
  allowed: boolean;
  hits: number;
  limit: number;
  remaining: number;
  retryAfter: number;
  resetAt: string;
}

async function hit(
  subjectId: string,
  bucket = 'unit-test',
  limit = 3,
  windowSeconds = 60,
): Promise<Decision> {
  const result = await client.query(`SELECT public.baaki_rate_limit($1, $2, $3, $4) AS decision`, [
    subjectId,
    bucket,
    limit,
    windowSeconds,
  ]);
  return result.rows[0].decision as Decision;
}

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

describe('baaki_rate_limit', () => {
  it('allows up to the limit and refuses the one after', async () => {
    const who = subject();

    const first = await hit(who);
    expect(first.allowed).toBe(true);
    expect(first.hits).toBe(1);
    expect(first.remaining).toBe(2);
    expect(first.retryAfter).toBe(0);

    expect((await hit(who)).allowed).toBe(true);
    expect((await hit(who)).allowed).toBe(true);

    const fourth = await hit(who);
    expect(fourth.allowed).toBe(false);
    expect(fourth.hits).toBe(4);
    expect(fourth.remaining).toBe(0);
    // Never zero on a refusal: a client told to wait zero seconds retries at
    // once, which is the behaviour being limited.
    expect(fourth.retryAfter).toBeGreaterThan(0);
    expect(fourth.retryAfter).toBeLessThanOrEqual(60);
  });

  it('counts each subject separately', async () => {
    const one = subject();
    const other = subject();

    await hit(one);
    await hit(one);
    await hit(one);
    expect((await hit(one)).allowed).toBe(false);

    // Somebody else's spree must not spend this person's allowance.
    expect((await hit(other)).allowed).toBe(true);
  });

  it('counts each bucket separately', async () => {
    const who = subject();

    await hit(who, 'bucket-a');
    await hit(who, 'bucket-a');
    await hit(who, 'bucket-a');
    expect((await hit(who, 'bucket-a')).allowed).toBe(false);

    // Hitting the export limit must not stop somebody writing an expense.
    expect((await hit(who, 'bucket-b')).allowed).toBe(true);
  });

  it('forgets everything once the window rolls over', async () => {
    const who = subject();

    // A one-second window, so the rollover can actually be waited for. The
    // window is floored to the clock, so waiting past the next boundary is
    // enough — no sleeping for a whole minute.
    expect((await hit(who, 'rollover', 1, 1)).allowed).toBe(true);
    expect((await hit(who, 'rollover', 1, 1)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const afterWait = await hit(who, 'rollover', 1, 1);
    expect(afterWait.allowed).toBe(true);
    expect(afterWait.hits).toBe(1);
  });

  it('counts correctly when many calls land at once', async () => {
    const who = subject();

    // Twenty *connections*, not twenty queries on one. `pg` serialises queries
    // issued on a single client — `Promise.all` over `client.query` runs them
    // one after another and proves nothing about concurrency, which is the only
    // thing this test exists to prove. It passed that way first.
    const clients = await Promise.all(Array.from({ length: 20 }, () => connect()));
    try {
      const decisions = await Promise.all(
        clients.map(async (each) => {
          const result = await each.query(
            `SELECT public.baaki_rate_limit($1, 'concurrent', 5, 60) AS decision`,
            [who],
          );
          return result.rows[0].decision as Decision;
        }),
      );

      // The reason the count is a single INSERT ... ON CONFLICT and not a
      // SELECT followed by an UPDATE: a read-then-write lets several callers
      // read 4 and all of them write 5.
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
      // Every caller got a distinct position, so nothing was lost or double-counted.
      expect(new Set(decisions.map((decision) => decision.hits)).size).toBe(20);
    } finally {
      await Promise.all(clients.map((each) => each.end()));
    }
  });

  it('refuses everything at a limit of zero, and does not divide by zero at a window of zero', async () => {
    const who = subject();

    expect((await hit(who, 'closed', 0, 60)).allowed).toBe(false);

    // A zero window is a caller's bug. It must be clamped, not raise.
    const clamped = await hit(who, 'zero-window', 5, 0);
    expect(clamped.allowed).toBe(true);
  });

  it('refuses a call with no subject rather than counting everybody together', async () => {
    // The dangerous failure here is silent: an empty subject would put every
    // caller in the world in one bucket and lock the app out for everybody.
    const message = await expectDenied(
      client.query(`SELECT public.baaki_rate_limit('', 'unit-test', 5, 60)`),
    );
    expect(message).toMatch(/needs a subject and a bucket/);
  });
});

describe('who may reach the limiter', () => {
  it('is unreadable and unwritable by anon and authenticated', async () => {
    const who = subject();
    await hit(who);

    // One statement per transaction. The first refusal aborts the transaction,
    // and every statement after it in the same block fails with "current
    // transaction is aborted" instead of the error being tested — which reads
    // like a pass to a regex looking for the wrong word, and did.
    for (const role of ['anon', 'authenticated'] as const) {
      // Not `toHaveLength(0)`: RLS with no policy returns zero rows to a role
      // that has SELECT, and a bare GRANT would sail through that. The grant is
      // revoked, so this must be an error.
      const denied = await asRole(client, role, { sub: randomUUID(), role }, () =>
        expectDenied(client.query(`SELECT * FROM public.rate_limit_hits`)),
      );
      expect(denied).toMatch(/permission denied/i);

      const insertDenied = await asRole(client, role, { sub: randomUUID(), role }, () =>
        expectDenied(
          client.query(
            `INSERT INTO public.rate_limit_hits (subject, bucket, window_start, hits)
             VALUES ($1, 'forged', now(), 0)`,
            [who],
          ),
        ),
      );
      expect(insertDenied).toMatch(/permission denied/i);
    }
  });

  it('cannot be called by a client role', async () => {
    // The function takes the subject as an argument, so a client able to call
    // it could spend somebody else's allowance and lock them out. This is the
    // whole reason it is service_role only.
    for (const role of ['anon', 'authenticated'] as const) {
      await asRole(client, role, { sub: randomUUID(), role }, async () => {
        const denied = await expectDenied(
          client.query(`SELECT public.baaki_rate_limit($1, 'unit-test', 5, 60)`, [subject()]),
        );
        expect(denied).toMatch(/permission denied/i);
      });
    }
  });

  it('can be called by service_role, which is how the edge functions reach it', async () => {
    const who = subject();
    await asRole(client, 'service_role', { role: 'service_role' }, async () => {
      const result = await client.query(
        `SELECT public.baaki_rate_limit($1, 'unit-test', 5, 60) AS decision`,
        [who],
      );
      expect((result.rows[0].decision as Decision).allowed).toBe(true);
    });
  });
});

describe('baaki_sweep_rate_limits', () => {
  it('deletes windows older than a day and leaves the current one alone', async () => {
    const stale = subject();
    const fresh = subject();

    await client.query(
      `INSERT INTO public.rate_limit_hits (subject, bucket, window_start, hits)
       VALUES ($1, 'sweep', now() - interval '2 days', 9)`,
      [stale],
    );
    await hit(fresh, 'sweep');

    await client.query(`SELECT public.baaki_sweep_rate_limits()`);

    const staleRows = await client.query(
      `SELECT 1 FROM public.rate_limit_hits WHERE subject = $1`,
      [stale],
    );
    const freshRows = await client.query(
      `SELECT 1 FROM public.rate_limit_hits WHERE subject = $1`,
      [fresh],
    );

    expect(staleRows.rowCount).toBe(0);
    expect(freshRows.rowCount).toBe(1);
  });
});
