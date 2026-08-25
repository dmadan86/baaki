/**
 * The invite-QR scanner, kept behind a runtime check.
 *
 * `expo-camera` is a native module. On a JS-only reload of an older dev-client
 * — one built before the module was installed — importing its `CameraView`
 * eagerly would reach for a native view that is not there. So nothing here
 * imports `expo-camera`; callers ask `cameraAvailable()` first and only mount
 * the camera leaf when the answer is yes, showing a "rebuild the app" notice
 * otherwise. Same discipline the document scanner uses (see `scanner.ts`).
 */

import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/** Whether this binary actually contains the camera module. False on web, and
 *  on any dev-client built before `expo-camera` was added. */
export function cameraAvailable(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  return requireOptionalNativeModule('ExpoCamera') != null;
}

/**
 * The invite token out of whatever the camera read.
 *
 * A Waves invite QR encodes the join URL (`https://baaki.app/join?token=…`, or
 * the `waves://join?token=…` deep link). We only trust a value that carries a
 * `token` query on a join URL; a random QR from a poster is not an invite, and
 * returns null so the screen can say so rather than routing nowhere.
 */
/** Where a real Waves invite points: the https link's host, and the deep-link
 *  schemes the app registers. Anything else is somebody else's QR. */
const INVITE_HOST = 'baaki.app';
const INVITE_SCHEMES = new Set(['waves', 'baaki']);

export function tokenFromScan(data: string): string | null {
  const text = data.trim();
  if (!text) return null;

  // A token must not carry a fragment; drop anything after '#' before reading
  // the query so `token=abc#frag` cannot smuggle the fragment into the token.
  const withoutFragment = text.split('#')[0];

  let parsed: URL;
  try {
    parsed = new URL(withoutFragment);
  } catch {
    return null;
  }

  // Only our own invite surfaces: the https link on the invite host, or the
  // app's own deep-link schemes. The path must be exactly /join, not merely
  // contain it, so `https://evil.example/x/join` is rejected.
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (scheme === 'https') {
    if (parsed.hostname.toLowerCase() !== INVITE_HOST || path !== '/join') return null;
  } else if (INVITE_SCHEMES.has(scheme)) {
    // `waves://join?token=…` parses with `join` as the host and an empty path;
    // `waves:///join?token=…` parses with an empty host and `/join` as the path.
    // Do not accept arbitrary hosts just because their path is `/join`.
    const host = parsed.hostname.toLowerCase();
    if (!((host === 'join' && path === '/') || (host === '' && path === '/join'))) return null;
  } else {
    return null;
  }

  // Read the token off the raw query rather than `searchParams`, whose support
  // is patchy in the React Native URL polyfill. The fragment is already gone, so
  // the capture cannot run past the query.
  const match = parsed.search.match(/[?&]token=([^&]+)/);
  const rawToken = match?.[1]?.trim();
  if (!rawToken) return null;
  try {
    const token = decodeURIComponent(rawToken).trim();
    return token.length > 0 ? token : null;
  } catch {
    return rawToken;
  }
}
