/**
 * The server half.
 *
 * Almost nothing runs here — every page is a client component — but the Next
 * server still renders the shell, and a failure at that point is a blank page
 * for somebody holding an invite link. `onRequestError` is what catches it.
 */

import * as Sentry from '@sentry/nextjs';

export async function register(): Promise<void> {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./sentry.server.config');
  if (process.env.NEXT_RUNTIME === 'edge') await import('./sentry.edge.config');
}

export const onRequestError = Sentry.captureRequestError;
