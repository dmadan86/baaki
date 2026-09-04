import 'server-only';

import { createClient } from '@supabase/supabase-js';

/**
 * Slows a brute-force at the login form.
 *
 * The console is one shared password. On a hostname that is (until Cloudflare
 * Access is wired up) publicly reachable, that makes the login form the whole
 * attack surface, and an unlimited form is a password guessed at line speed.
 *
 * The counting is done in Postgres by `waves_rate_limit` — the same limiter the
 * edge functions use (`supabase/functions/_shared/rateLimit.ts`) — and not in
 * memory, for the same reason it is written up there: Vercel runs the middleware
 * and server actions across many short-lived isolates, so an in-memory counter
 * would count almost nothing and look like it worked in a single-instance test.
 * Keyed on the client address, since there is no signed-in identity to blame at
 * a login. The bucket carries its own limit here rather than relying on a
 * `rate_limit_rules` row, so it works whether or not one has been configured.
 *
 * Fails open. If the count cannot be taken — the only realistic cause being the
 * database being unreachable — the attempt proceeds. This console must keep
 * working when the thing it watches is down, and a limiter that turns a database
 * blip into a lockout of the one operator has done more harm than the slow
 * guessing it was there to stop.
 */

const BUCKET = 'admin-login';

/** Ten tries per quarter hour, per address. Far more than a person fat-fingering
 * a password, far less than a script needs to be worth running. */
const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the window reopens. Zero when allowed. */
  retryAfter: number;
}

function service() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Reads the client address the way the edge limiter does: the first entry of
 * `x-forwarded-for`, which is the client as the first proxy saw it. Spoofable in
 * general, but a caller willing to rotate that header per request only earns a
 * slower oracle, not an open one — and behind Cloudflare the header is set by a
 * hop the attacker does not control.
 */
export function clientAddress(forwardedFor: string | null | undefined): string {
  const first = (forwardedFor ?? '').split(',')[0]?.trim();
  return first || 'unknown';
}

/**
 * Counts one login attempt against the address and reports whether it is now
 * over the line. Call it on every submit, before checking the password, so a
 * locked address cannot even test a guess.
 */
export async function recordLoginAttempt(address: string): Promise<ThrottleDecision> {
  const svc = service();
  if (!svc) return { allowed: true, retryAfter: 0 };

  const { data, error } = await svc.rpc('waves_rate_limit', {
    p_subject: `ip:${address}`,
    p_bucket: BUCKET,
    p_limit: MAX_ATTEMPTS,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (error) {
    console.error('admin login throttle check failed, allowing attempt:', error.message);
    return { allowed: true, retryAfter: 0 };
  }

  const decision = data as { allowed?: boolean; retryAfter?: number } | null;
  if (!decision || decision.allowed) return { allowed: true, retryAfter: 0 };

  const retryAfter = Math.max(Number(decision.retryAfter) || 1, 1);
  // The alert signal. A lockout means either the operator is having a bad day or
  // somebody is guessing; both are worth a line that log-based alerting can key
  // on. No secret, no address of ours, nothing that helps an attacker.
  console.warn(
    `[ALERT] admin-login lockout: address=${address} bucket=${BUCKET} retryAfterSeconds=${retryAfter}`,
  );
  return { allowed: false, retryAfter };
}
