/**
 * Database errors, said out loud in a way somebody can act on.
 *
 * Found by running the feedback screen on an emulator against a project the
 * migration had not reached: the screen showed
 *
 *   Could not find the function public.baaki_submit_feedback(p_app_version,
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

/** The shape supabase-js hands back on a failed rpc. */
interface Postgrestish {
  message?: string;
  code?: string;
}

export function friendlyError(caught: unknown, fallback: string, where: string): string {
  const error = (caught ?? {}) as Postgrestish;
  const message = typeof error.message === 'string' ? error.message : String(caught);

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

  // A network failure already reads plainly, and telling somebody their
  // connection dropped is worth more than a generic apology.
  return message;
}
