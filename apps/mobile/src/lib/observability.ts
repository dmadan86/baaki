/**
 * Crash reporting, on terms Baaki can live with.
 *
 * TDR §11 asks for crash-free sessions above 99.5%, which needs something
 * counting sessions and crashes. The awkward part is what else that something
 * picks up on the way: a Sentry event, left to its defaults, carries the URL of
 * the request that failed, the last few console lines, and whatever the app
 * handed it as context. In an expense splitter that is a list of who ate with
 * whom, the number they were invited on, and the handle they pay from.
 *
 * So nothing leaves without going through `scrub` from @waves/core — the same
 * policy the web view and the edge functions use, tested there rather than
 * here. This file is the wiring; `packages/core/src/observability/scrub.ts` is
 * the rule.
 *
 * With no DSN set this is inert: `init` returns immediately and every other
 * function is a no-op. A developer without a Sentry account runs the app with
 * no reporting rather than a crash on boot, and no build step is required to
 * make that true.
 */

import * as Sentry from '@sentry/react-native';

import { scrub } from '@waves/core';

/**
 * A DSN is public by design — it only permits *writing* events, which is why it
 * ships in every binary that reports a crash. It is `EXPO_PUBLIC_` for the same
 * reason the anon key is: no secret is being kept here. The token that can
 * *read* the project, `SENTRY_AUTH_TOKEN`, is a build-time secret and never
 * enters the bundle (TDR §11).
 */
const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

/** Whether anything is being reported at all. Useful in a settings screen. */
export const reportingEnabled = Boolean(DSN);

export function initObservability(): void {
  if (!DSN) return;

  Sentry.init({
    dsn: DSN,
    environment: process.env.EXPO_PUBLIC_ENV ?? (__DEV__ ? 'development' : 'production'),

    // The one number TDR §11 is actually about.
    enableAutoSessionTracking: true,

    // Never attach the user's email, phone or IP, whatever the SDK can see.
    sendDefaultPii: false,

    // A screenshot of a group screen is a full disclosure of the ledger, and a
    // view hierarchy is the same thing in text. Neither is worth a crash fix.
    attachScreenshot: false,
    attachViewHierarchy: false,

    // Sampled in production because tracing is per-transaction billing and a
    // splitting app is chatty; full rate locally, where the traces are read.
    tracesSampleRate: __DEV__ ? 1.0 : 0.1,

    beforeSend: (event) => scrub(event),
    beforeBreadcrumb: (breadcrumb) => {
      // Console breadcrumbs are the one class the scrubber cannot make safe:
      // `console.log('saving', expense)` produces a sentence with a description
      // in it that matches no pattern and sits under no known key. The rest —
      // navigation, fetch, lifecycle — is diagnosis, and goes through scrub
      // like everything else.
      if (breadcrumb.category === 'console') return null;
      return scrub(breadcrumb);
    },
  });
}

/**
 * Ties a report to an account without saying who owns it.
 *
 * The id is the Supabase user id — an opaque UUID, and the only way to tell
 * "one person hit this fifty times" from "fifty people did". Turning it back
 * into a person requires the database, which requires passing RLS.
 */
export function identifyForReporting(userId: string | null): void {
  if (!reportingEnabled) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/**
 * Report something the app handled but should not have had to.
 *
 * A failed sync or a refused mutation is not a crash — the user sees a message
 * and carries on — but it is exactly the class of bug that never gets reported
 * by hand.
 */
export function reportHandled(error: unknown, where: string): void {
  if (!reportingEnabled) return;
  Sentry.captureException(error, { tags: { where } });
}

/** Wraps the root component for the native error boundary and route tracing. */
export const withObservability = Sentry.wrap;
