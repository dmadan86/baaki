import type { NextConfig } from 'next';

/**
 * The opposite decision to web-lite's, for the opposite reason.
 *
 * Every page here is a **server** component. The console reads with the service
 * role, which bypasses RLS on every table in the database (ADR-013) — that key
 * can never reach a browser, so the fetch can never move to the client. There
 * is no Supabase client in this app's bundle at all, and no anon key either.
 *
 * `poweredByHeader` off and `noindex` in the layout: this is a private console,
 * and the less it announces about itself the better.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        // Added alongside the existing three: pin HTTPS, stop MIME sniffing,
        // and forbid framing at the CSP level too. A private console has no
        // reason ever to be embedded or served over plaintext.
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        {
          key: 'Content-Security-Policy',
          value: "frame-ancestors 'none'; upgrade-insecure-requests",
        },
      ],
    },
  ],
};

export default nextConfig;
