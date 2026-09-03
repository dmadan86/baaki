/**
 * The one place the marketing/web-lite site's domain is named.
 *
 * `INVITE_HOST` (the QR scanner's allowlist, {@link ../lib/qrScan}) and
 * `INVITE_BASE` (the link generator, `groupJoinLink`) used to carry the same
 * domain as two separate hardcoded strings — an unowned placeholder
 * (`baaki.app`), left over from before the app was renamed. Two copies of a
 * security-relevant host is a drift risk: change one and the QR scanner
 * silently stops trusting the app's own invite links, or worse, still trusts
 * whatever the old one was. This is the single source both read from.
 *
 * Pure — no React Native, no network — so it can be imported into
 * `mapTiles.ts` (deliberately RN-free, see its own header) without pulling
 * anything heavier along with it.
 */

/** Trailing slash stripped so every consumer can assume `${WEB_URL}/path`. */
export const WEB_URL = (process.env.EXPO_PUBLIC_WEB_URL || 'https://wavs.co.in').replace(
  /\/+$/,
  '',
);

/** Base of a group's durable join link — see `groupJoinLink`. */
export const INVITE_BASE = `${WEB_URL}/join`;

/** The join link's host, for the QR scanner's allowlist. */
export const INVITE_HOST = new URL(INVITE_BASE).hostname.toLowerCase();

/** A group's durable join link from its join token — the same string the invite
 *  screen paints as a QR and shares. Kept here so every place that shares a link
 *  (the invite screen, the post-merge invite sheet) builds the identical URL. */
export function groupJoinLink(token: string): string {
  return `${INVITE_BASE}#${token}`;
}
