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

/**
 * Runs `attempt`, and runs it again if the rate limit window rolled over while
 * it was running.
 *
 * Windows are floored to the wall clock — `floor(epoch / window) * window` — so
 * the boundary is a property of the time of day, not of when the test started.
 * A burst that straddles one is counted twice from zero, and every assertion
 * about the count is then wrong: the call that should have been refused is
 * allowed, because as far as the limiter is concerned it is the first of a new
 * minute.
 *
 * This is not hypothetical and not rare enough to ignore. It turned this file
 * red on a pull request that changed nothing but the README, and a one-second
 * window makes it a hundred times likelier still.
 *
 * `windows` names the decisions that had to share a window. Every decision the
 * assertions depend on belongs in it — checking only the last two would miss a
 * rollover between the first two, which shifts the count just as badly.
 */
async function inOneWindow<T>(
  attempt: () => Promise<T>,
  windows: (result: T) => readonly Decision[],
): Promise<T> {
  const attempts = 5;
  for (let remaining = attempts; remaining > 0; remaining -= 1) {
    const result = await attempt();
    if (new Set(windows(result).map((decision) => decision.resetAt)).size === 1) return result;
  }
  // Not a silent pass. Five rollovers in a row is a broken clock or a limiter
  // that no longer agrees with itself, and either is worth stopping for.
  throw new Error(`the rate limit window rolled over on all ${attempts} attempts`);
}

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

describe('baaki_rate_limit', () => {
  it('allows up to the limit and refuses the one after', async () => {
    const { first, second, third, fourth } = await inOneWindow(
      async () => {
        const who = subject();
        return {
          first: await hit(who),
          second: await hit(who),
          third: await hit(who),
          fourth: await hit(who),
        };
      },
      (run) => [run.first, run.second, run.third, run.fourth],
    );

    expect(first.allowed).toBe(true);
    expect(first.hits).toBe(1);
    expect(first.remaining).toBe(2);
    expect(first.retryAfter).toBe(0);

    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);

    expect(fourth.allowed).toBe(false);
    expect(fourth.hits).toBe(4);
    expect(fourth.remaining).toBe(0);
    // Never zero on a refusal: a client told to wait zero seconds retries at
    // once, which is the behaviour being limited.
    expect(fourth.retryAfter).toBeGreaterThan(0);
    expect(fourth.retryAfter).toBeLessThanOrEqual(60);
  });

  it('counts each subject separately', async () => {
    const { fourth, stranger } = await inOneWindow(
      async () => {
        const one = subject();
        const other = subject();
        return {
          first: await hit(one),
          second: await hit(one),
          third: await hit(one),
          fourth: await hit(one),
          stranger: await hit(other),
        };
      },
      (run) => [run.first, run.second, run.third, run.fourth, run.stranger],
    );

    expect(fourth.allowed).toBe(false);

    // Somebody else's spree must not spend this person's allowance.
    expect(stranger.allowed).toBe(true);
  });

  it('counts each bucket separately', async () => {
    const { fourth, otherBucket } = await inOneWindow(
      async () => {
        const who = subject();
        return {
          first: await hit(who, 'bucket-a'),
          second: await hit(who, 'bucket-a'),
          third: await hit(who, 'bucket-a'),
          fourth: await hit(who, 'bucket-a'),
          otherBucket: await hit(who, 'bucket-b'),
        };
      },
      (run) => [run.first, run.second, run.third, run.fourth, run.otherBucket],
    );

    expect(fourth.allowed).toBe(false);

    // Hitting the export limit must not stop somebody writing an expense.
    expect(otherBucket.allowed).toBe(true);
  });

  it('forgets everything once the window rolls over', async () => {
    // A one-second window, so the rollover can actually be waited for. The
    // window is floored to the clock, so waiting past the next boundary is
    // enough — no sleeping for a whole minute.
    //
    // Which is also why the first two hits go through `inOneWindow`: at a
    // one-second window the boundary this test is about can land *between*
    // them, and then the second hit is allowed and the rollover being tested
    // has already happened before the wait.
    const { who, second } = await inOneWindow(
      async () => {
        const each = subject();
        return {
          who: each,
          first: await hit(each, 'rollover', 1, 1),
          second: await hit(each, 'rollover', 1, 1),
        };
      },
      (run) => [run.first, run.second],
    );

    expect(second.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const afterWait = await hit(who, 'rollover', 1, 1);
    expect(afterWait.allowed).toBe(true);
    expect(afterWait.hits).toBe(1);
  });

  it('counts correctly when many calls land at once', async () => {
    // A rollover here would split the twenty callers across two windows and
    // break both assertions below — five allowed becomes ten, and the twenty
    // distinct positions become two runs of overlapping ones.
    const decisions = await inOneWindow(
      async () => {
        const who = subject();

        // Twenty *connections*, not twenty queries on one. `pg` serialises
        // queries issued on a single client — `Promise.all` over `client.query`
        // runs them one after another and proves nothing about concurrency,
        // which is the only thing this test exists to prove. It passed that way
        // first.
        const clients = await Promise.all(Array.from({ length: 20 }, () => connect()));
        try {
          return await Promise.all(
            clients.map(async (each) => {
              const result = await each.query(
                `SELECT public.baaki_rate_limit($1, 'concurrent', 5, 60) AS decision`,
                [who],
              );
              return result.rows[0].decision as Decision;
            }),
          );
        } finally {
          await Promise.all(clients.map((each) => each.end()));
        }
      },
      (all) => all,
    );

    // The reason the count is a single INSERT ... ON CONFLICT and not a
    // SELECT followed by an UPDATE: a read-then-write lets several callers
    // read 4 and all of them write 5.
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    // Every caller got a distinct position, so nothing was lost or double-counted.
    expect(new Set(decisions.map((decision) => decision.hits)).size).toBe(20);
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

describe('the guard the tests above rely on', () => {
  it('retries a burst that the window rolled over underneath', async () => {
    let attempts = 0;

    // A one-second window and a stall longer than it, so the rollover is caused
    // rather than waited for. Without `inOneWindow` this is the shape that made
    // CI red: the second hit is counted as the first of a new window.
    const result = await inOneWindow(
      async () => {
        attempts += 1;
        const who = subject();
        const first = await hit(who, 'guard', 3, 1);
        if (attempts === 1) await new Promise((resolve) => setTimeout(resolve, 1_100));
        const second = await hit(who, 'guard', 3, 1);
        return { first, second };
      },
      (run) => [run.first, run.second],
    );

    // The first attempt was thrown away rather than asserted on.
    expect(attempts).toBeGreaterThan(1);
    expect(result.first.resetAt).toBe(result.second.resetAt);
    expect(result.second.hits).toBe(2);
  });

  it('gives up loudly rather than returning a split burst', async () => {
    // If the retry ever stops working, the tests above must fail rather than
    // quietly assert against two windows.
    await expect(
      inOneWindow(
        async () => {
          const who = subject();
          const first = await hit(who, 'guard-always', 3, 1);
          await new Promise((resolve) => setTimeout(resolve, 1_100));
          return { first, second: await hit(who, 'guard-always', 3, 1) };
        },
        (run) => [run.first, run.second],
      ),
    ).rejects.toThrow(/rolled over on all 5 attempts/);
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
