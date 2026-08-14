/**
 * Shared edge-function plumbing (ADR-013).
 *
 * Two clients, on purpose:
 *  - `asCaller` runs with the caller's JWT, so RLS applies and membership is
 *    checked by the same policies the app is subject to.
 *  - `asService` bypasses RLS and is only ever used *after* an explicit
 *    authorization check.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// Re-exported so the version above is pinned in one place. `rateLimit.ts` needs
// the type and should not be a second file deciding which SDK major this is.
export type { SupabaseClient };

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * The origins allowed to read a response in a browser, from `ALLOWED_ORIGINS`
 * (comma-separated). Left empty the value is `*` — the historical default —
 * so nothing changes until the env var is set; every function goes through the
 * same list the moment it is.
 *
 * This only ever matters to a browser: these APIs authenticate on the
 * `Authorization` header, never a cookie, and set no `Allow-Credentials`, so a
 * permissive value cannot be turned into credentialed cross-origin theft. The
 * allowlist is defence in depth against a stray site scripting the API in a
 * signed-in user's browser, not the thing standing between an attacker and the
 * data. Native clients send no `Origin` and ignore CORS entirely.
 */
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function allowedOrigin(request: Request): string {
  if (ALLOWED_ORIGINS.length === 0) return '*';
  const origin = request.headers.get('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  // A configured origin the browser did not send: any real allowlisted value
  // works as a deliberate non-match, so an unlisted site's request fails the
  // browser's own origin check.
  return ALLOWED_ORIGINS[0];
}

/**
 * `Deno.serve` with CORS handled once, in one place: the preflight is answered
 * and every response leaves with the resolved `Access-Control-Allow-Origin`
 * (overriding the `*` that `json()` still carries for the no-allowlist case).
 * Functions call this instead of `Deno.serve` and drop their own OPTIONS line.
 */
export function serveWithCors(handler: (request: Request) => Promise<Response>): void {
  Deno.serve(async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response('ok', {
        headers: { ...CORS_HEADERS, 'Access-Control-Allow-Origin': allowedOrigin(request) },
      });
    }
    const response = await handler(request);
    response.headers.set('Access-Control-Allow-Origin', allowedOrigin(request));
    // Cached by any proxy keyed on the origin it was resolved for, never reused
    // across origins.
    if (ALLOWED_ORIGINS.length > 0) response.headers.set('Vary', 'Origin');
    return response;
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * Extra response headers. Only the rate limiter uses this so far, to send
     * `Retry-After` — a 429 that does not say how long to wait is one every
     * client has to guess at, and they guess "immediately".
     */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/**
 * Parse a minor-unit money string to BigInt, or fail with a 400 — never a 500.
 * A bare `BigInt(value)` on a malformed field throws a SyntaxError that escapes
 * as a generic 500 INTERNAL, which `/sync` then treats as retryable and replays.
 * Bad client input is a client error and must be reported as one.
 */
export function parseMinor(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new HttpError(400, 'INVALID_AMOUNT', `${field} must be an integer in minor units`);
  }
  return BigInt(value);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json', ...headers },
  });
}

export async function errorResponse(
  error: unknown,
  context: Record<string, string> = {},
): Promise<Response> {
  if (error instanceof HttpError) {
    // A refusal the caller can act on. Not a crash, and not reported — burying
    // the real failures under thousands of `NOT_A_MEMBER` is how a crash
    // reporter stops being read.
    return json({ code: error.code, message: error.message }, error.status, error.headers);
  }
  const message = error instanceof Error ? error.message : String(error);
  // Never leak internals to the client; the detail stays in the function log.
  console.error('unhandled edge error:', message);

  // Loaded here rather than at the top of the file: the Sentry SDK costs an
  // npm module load on every cold start, and this path is by definition the
  // one that already went wrong.
  try {
    const { reportEdgeError, flushReports } = await import('./observability.ts');
    reportEdgeError(error, context);
    keepAlive(flushReports());
  } catch (reportingFailed) {
    // A broken reporter must never turn a 500 into a hang.
    console.error('could not report edge error:', reportingFailed);
  }

  return json({ code: 'INTERNAL', message: 'Something went wrong' }, 500);
}

/**
 * Deno may tear the isolate down the moment the response is returned, which
 * would drop a report still in flight. Supabase's runtime exposes `waitUntil`
 * for exactly this; elsewhere the promise is simply left to settle.
 */
function keepAlive(work: Promise<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(work);
  else void work;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, 'MISCONFIGURED', `${name} is not set`);
  return value;
}

export function asCaller(request: Request): SupabaseClient {
  const authorization = request.headers.get('Authorization');
  if (!authorization) {
    throw new HttpError(401, 'NOT_AUTHENTICATED', 'Missing Authorization header');
  }
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
}

export function asService(): SupabaseClient {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
}

/** Throws unless the caller is a live member of the group. */
export async function requireMembership(
  caller: SupabaseClient,
  groupId: string,
): Promise<{ profileId: string; memberId: string }> {
  const { data: user, error: userError } = await caller.auth.getUser();
  if (userError || !user?.user) {
    throw new HttpError(401, 'NOT_AUTHENTICATED', 'Sign in first');
  }

  const { data: memberId, error } = await caller.rpc('baaki_my_member_id', {
    p_group_id: groupId,
  });
  if (error) throw new HttpError(500, 'INTERNAL', error.message);
  if (!memberId) {
    throw new HttpError(403, 'NOT_A_MEMBER', 'You are not a member of this group');
  }

  return { profileId: user.user.id, memberId: memberId as string };
}
