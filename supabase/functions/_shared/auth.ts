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

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
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
    return json({ code: error.code, message: error.message }, error.status);
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
