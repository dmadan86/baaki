/**
 * Crash reporting for the guest view.
 *
 * This is the app that runs for somebody who has installed nothing — they
 * followed a link, and if the page breaks they close the tab and the group
 * never hears from them again. There is no crash dialog and no way for them to
 * tell anyone, so unreported is the default outcome here in a way it is not on
 * mobile.
 *
 * Every page is a client component (see next.config.ts), so this file is where
 * essentially all of the app's errors are. Events go through the same `scrub`
 * as the mobile app and the edge functions — one policy, tested in
 * @baaki/core, not three that drift.
 *
 * Inert without a DSN, so a clone with no Sentry account builds and runs.
 */

import * as Sentry from '@sentry/nextjs';

import { scrub } from '@baaki/core';

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NEXT_PUBLIC_ENV ?? process.env.NODE_ENV,

    sendDefaultPii: false,

    // No session replay. A replay of this app is a recording of somebody's
    // ledger, and the masking options are a setting somebody can get wrong
    // once — the only version that cannot leak is the one not recorded.
    tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,

    beforeSend: (event) => scrub(event),
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.category === 'console') return null;
      return scrub(breadcrumb);
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
