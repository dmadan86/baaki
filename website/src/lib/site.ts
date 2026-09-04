/**
 * Everything about "where this site lives" in one place. The marketing site is
 * the apex domain; the product itself is a separate deployment, so the CTAs
 * point outward rather than into a route that does not exist here.
 */
export const site = {
  name: 'Waves',
  domain: 'wavs.co.in',
  url: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://wavs.co.in',
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.wavs.co.in',
  supportEmail: 'hello@wavs.co.in',
} as const;

/** Absolute URL for a locale-prefixed path, used by metadata and the sitemap. */
export function absoluteUrl(path = ''): string {
  const trimmed = path.startsWith('/') ? path : `/${path}`;
  return `${site.url}${trimmed === '/' ? '' : trimmed}`;
}
