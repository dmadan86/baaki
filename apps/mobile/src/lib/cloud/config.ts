/**
 * Which OAuth client this build presents, and whether it has one at all.
 *
 * Drive needs its own client ids — the app's *login* goes through Supabase's
 * hosted Google flow and never holds a Google client id of its own, so nothing
 * here is shared with sign-in. Google binds a native OAuth client to a platform
 * identity: Android to the package name plus the signing SHA-1, iOS to the
 * bundle id. One id therefore cannot serve both, and the release and debug
 * Android builds need separate ones because they are signed with different
 * keys.
 *
 * The ids are not secret — a native OAuth client has no secret, which is why
 * this app uses PKCE — but they name a Google Cloud project that belongs to
 * whoever is building, so they are read from the environment rather than
 * committed. `EXPO_PUBLIC_*` is inlined by Metro at build time, which is why
 * each one is spelled out statically below: a computed `process.env[key]` is
 * not substituted and would read as undefined in a release bundle.
 *
 * With none set the app builds and runs; the backup screen says the destination
 * is unavailable in this build instead of opening a consent page that would be
 * rejected. See README, "Backing the personal ledger up to Drive".
 */

import { Platform } from 'react-native';

import type { CloudProviderId } from './types';

/** The Drive OAuth client for the platform this build is running on. */
function googleDriveClientId(): string | undefined {
  const id = Platform.select({
    android: process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_ANDROID,
    ios: process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_IOS,
    default: process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_WEB,
  });
  return id && id.length > 0 ? id : undefined;
}

export function clientId(provider: CloudProviderId): string {
  const id = provider === 'gdrive' ? googleDriveClientId() : undefined;
  // Callers gate on `isConfigured` first; reaching here without an id is a
  // programming error, not a user-facing state, so it throws rather than
  // sending an empty `client_id` to a consent page.
  if (!id) throw new Error(`no OAuth client id configured for ${provider}`);
  return id;
}

export function isConfigured(provider: CloudProviderId): boolean {
  return provider === 'gdrive' && googleDriveClientId() !== undefined;
}
