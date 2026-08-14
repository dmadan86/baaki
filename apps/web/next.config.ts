import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

/**
 * Every page that reads data is a client component, and that is a decision
 * rather than a default.
 *
 * Reads happen in the visitor's browser under their own session, so RLS is
 * what decides what they see (ADR-013). Rendering a group on the server would
 * need a key of its own, and the only key able to render somebody else's group
 * is one that must never leave an edge function (TDR §11). Nothing is gained
 * by moving the fetch: the page is behind an invite token either way.
 *
 * The layout and the home page are the exception, and read nothing: they are
 * server components solely so `Accept-Language` can decide `lang` and `dir`
 * before the first paint. A language guessed twice — once on the server and
 * again from `navigator.language` — is a page that visibly changes its mind.
 *
 * A static export would have been simpler still, but the invite links already
 * in circulation are `/join/<token>` — a dynamic segment whose values cannot
 * be known at build time. Changing the link shape to a query string would
 * break every link already sent.
 */
/**
 * Response security headers for every route.
 *
 * This app is a public SPA behind an invite token, so the headers are the
 * conservative, framework-agnostic set that cannot break script loading:
 * HSTS to pin HTTPS, `nosniff`, a strict referrer policy, and clickjacking
 * protection via both `X-Frame-Options` and a CSP `frame-ancestors 'none'`.
 * `upgrade-insecure-requests` is the only CSP directive here — a full
 * script/style CSP needs per-request nonces this static config cannot mint,
 * and a wrong one would silently break hydration, so it is deliberately left
 * to a follow-up rather than shipped untested.
 */
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; upgrade-insecure-requests" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  headers: async () => [{ source: '/:path*', headers: SECURITY_HEADERS }],
};

/**
 * Source-map upload needs an organisation, a project and a write token, none of
 * which belong in the repository. Without them the build is left alone rather
 * than half-wired: reporting still works — it just arrives minified — and a
 * clone with no Sentry account builds exactly as it did before.
 */
const sentryConfigured = Boolean(process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);

export default sentryConfigured
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // Sentry's own domain is a popular thing to block, and a blocked report
      // is one nobody knows was lost.
      tunnelRoute: '/monitoring',
      silent: !process.env.CI,
    })
  : nextConfig;
