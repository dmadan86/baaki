/**
 * Database errors, said out loud in a way somebody can act on.
 *
 * Found by running the feedback screen on an emulator against a project the
 * migration had not reached: the screen showed
 *
 *   Could not find the function public.waves_submit_feedback(p_app_version,
 *   p_kind, p_message, p_platform) in the schema cache
 *
 * to a person who was in the middle of typing a complaint. PostgREST messages
 * are written for whoever wrote the query, and every one of them is a sentence
 * about the schema rather than about what the person just tried to do.
 *
 * The original is not thrown away — it goes to the crash reporter, which is
 * where a message naming a function signature is actually useful.
 */

import { reportHandled } from '@/lib/observability';

/** The shape supabase-js hands back on a failed rpc or auth call. */
interface Postgrestish {
  message?: string;
  code?: string;
  /** supabase-js AuthError carries the HTTP status — 429 on a rate limit. */
  status?: number;
}

export function friendlyError(
  caught: unknown,
  fallback: string,
  where: string,
  offline?: string,
  tooMany?: string,
): string {
  const error = (caught ?? {}) as Postgrestish;
  const message =
    typeof error.message === 'string' ? error.message : typeof caught === 'string' ? caught : '';

  // Reported, then replaced. A build that reaches a project without the
  // migration is a deployment mistake somebody has to hear about.
  reportHandled(caught, where);

  // No such function or table: the server is older than this build.
  if (error.code === 'PGRST202' || error.code === 'PGRST205' || /schema cache/i.test(message)) {
    return fallback;
  }
  // Signed out mid-action, or a token that expired while the screen was open.
  if (/NOT_SIGNED_IN|JWT|not authenticated/i.test(message)) {
    return fallback;
  }
  // Anything the database rejected by name is still not a sentence.
  if (/violates|constraint|permission denied|relation .* does not exist/i.test(message)) {
    return fallback;
  }

  // Too many requests in too short a window — the one-time-code buttons hit
  // Supabase's email send-rate limit if tapped repeatedly. "Could not sign in"
  // reads as a rejected credential here, which is wrong: the request was fine,
  // there were just too many. Say to wait, not to doubt what they typed.
  if (
    error.status === 429 ||
    /rate limit|too many requests|over_.*_rate_limit/i.test(message) ||
    /rate.?limit/i.test(typeof error.code === 'string' ? error.code : '')
  ) {
    return tooMany ?? fallback;
  }

  // A network failure is worth naming — telling somebody their connection
  // dropped beats a generic apology. But the raw message is not safe to echo:
  // a native transport failure surfaces as internal noise, e.g. a TLS
  // handshake error arriving as "fetch failed: UnexpectedException: A TLS
  // error caused the secure connection to fail. (at
  // ExpoModulesCore/Promise.swift:56)". That names an exception class and a
  // Swift file:line to a person trying to sign in. So: recognise the network
  // case, but return the caller's clean connection sentence (or the generic
  // fallback), never the raw string. The original still goes to the crash
  // report via reportHandled above. Everything else is a sentence about the
  // schema, so it stays in the crash report only.
  if (/network request failed|fetch failed|timeout|offline|tls|secure connection/i.test(message))
    return offline ?? fallback;
  return fallback;
}
