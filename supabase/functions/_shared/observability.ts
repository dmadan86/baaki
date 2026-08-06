/**
 * Server-side crash reporting.
 *
 * The mobile app tells you when it dies. An edge function does not: it returns
 * `INTERNAL: Something went wrong`, the client shows a toast, and the reason is
 * a line in a log nobody is reading. That is not a hypothetical — a
 * `SplitError` escaping `computeShares` as an unhandled 500 lived in
 * `expense-write` and `/sync` until an end-to-end script happened to print the
 * body, and in `/sync` it was worse than useless: the queue treats a 500 as
 * retryable, so a mutation that could never succeed was retried eight times
 * before dying.
 *
 * Everything reported here goes through the same `scrub` as the two clients.
 * The server sees *more* than they do — the whole request body, the service
 * role's view of a row — so the policy matters more, not less.
 *
 * Inert without `SENTRY_DSN` in the function environment, which is how a local
 * `supabase functions serve` stays offline.
 */

import * as Sentry from 'npm:@sentry/deno@10';

import { scrub } from './core.js';

const DSN = Deno.env.get('SENTRY_DSN');

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production',
    sendDefaultPii: false,
    // No tracing on the server: these are short single-shot handlers, and the
    // question worth answering here is "what broke", not "what was slow".
    tracesSampleRate: 0,
    beforeSend: (event: unknown) => scrub(event),
  });
}

export const reportingEnabled = Boolean(DSN);

/**
 * Report a failure that was not the caller's fault.
 *
 * A refused mutation is not reported: `EXACT_SUM_MISMATCH` and `NOT_A_MEMBER`
 * are the function working correctly, and burying the real crashes under
 * thousands of them is how a crash reporter stops being read. Only what falls
 * through to a 500 arrives here.
 */
export function reportEdgeError(error: unknown, context: Record<string, string>): void {
  if (!DSN) return;
  Sentry.captureException(error, { tags: scrub(context) });
}

/**
 * Deno may kill the isolate the moment the response is returned, so a report
 * queued during the request can be dropped in transit. Supabase's runtime
 * accepts a promise to keep alive past the response for exactly this.
 */
export function flushReports(): Promise<boolean> {
  if (!DSN) return Promise.resolve(true);
  return Sentry.flush(2000);
}
