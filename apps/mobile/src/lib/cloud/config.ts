/**
 * The OAuth client ids for the three backup providers.
 *
 * These are *public* installed-app client ids, not secrets: the flow is PKCE
 * (no client secret ships in the app), so a client id is safe to embed and safe
 * to leave blank. They come from the environment rather than being hard-coded
 * because they name developer accounts that belong to whoever builds Baaki, not
 * to this repository — exactly like the Sentry and FCM credentials in
 * `app.config.ts`. `EXPO_PUBLIC_*` is inlined by Metro at build time.
 *
 * A blank id is a supported state, not a misconfiguration: the provider reports
 * itself unconfigured and the settings screen shows "not set up" instead of a
 * Connect button that would open a broken consent screen.
 */

import type { CloudProviderId } from './types';

export const CLOUD_CLIENT_IDS: Record<CloudProviderId, string> = {
  gdrive: process.env.EXPO_PUBLIC_CLOUD_GDRIVE_CLIENT_ID ?? '',
  dropbox: process.env.EXPO_PUBLIC_CLOUD_DROPBOX_CLIENT_ID ?? '',
  onedrive: process.env.EXPO_PUBLIC_CLOUD_ONEDRIVE_CLIENT_ID ?? '',
};

export function clientId(id: CloudProviderId): string {
  return CLOUD_CLIENT_IDS[id];
}

export function isConfigured(id: CloudProviderId): boolean {
  return CLOUD_CLIENT_IDS[id].length > 0;
}

/** The folder receipts are filed under in the user's drive, on every provider. */
export const BACKUP_FOLDER = 'Baaki Receipts';
