import type { NextConfig } from 'next';

/**
 * Every page here is a client component, and that is a decision rather than a
 * default.
 *
 * Reads happen in the visitor's browser under their own session, so RLS is
 * what decides what they see (ADR-013). Rendering a group on the server would
 * need a key of its own, and the only key able to render somebody else's group
 * is one that must never leave an edge function (TDR §11). Nothing is gained
 * by moving the fetch: the page is behind an invite token either way.
 *
 * A static export would have been simpler still, but the invite links already
 * in circulation are `/join/<token>` — a dynamic segment whose values cannot
 * be known at build time. Changing the link shape to a query string would
 * break every link already sent.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
