/**
 * Where a provider's OAuth tokens live: the OS keystore, not AsyncStorage, and
 * under the account that granted them.
 *
 * A refresh token for someone's Google Drive is exactly the kind of long-lived
 * credential the app's own session hardening moved out of plaintext, so it
 * rides the same chunked SecureStore adapter (`secureAuthStorage`) that the
 * Supabase session uses — Keychain on iOS, Keystore on Android, AsyncStorage
 * only on web where there is no keystore.
 *
 * The owner id in the key is not decoration. These are device-wide stores on a
 * device that is not always one person's: without it, B signing in after A
 * inherits a live, write-capable token into A's Drive. Scoping is the first of
 * three guards (the other two are the sign-out wipe in `backup/engine.ts` and
 * the owner in the remote filename); each covers a case the others do not.
 */

import { secureAuthStorage } from '../secureStorage';
import type { CloudProviderId, CloudTokens } from './types';

const key = (id: CloudProviderId, ownerId: string): string => `waves.cloud.tokens.${id}.${ownerId}`;

export async function loadTokens(
  id: CloudProviderId,
  ownerId: string,
): Promise<CloudTokens | null> {
  if (!ownerId) return null;
  const raw = await secureAuthStorage.getItem(key(id, ownerId)).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CloudTokens>;
    // A stored blob with no access token is not usable and not worth keeping
    // as "connected" — treat it as absent so the screen offers Connect.
    return typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0
      ? {
          accessToken: parsed.accessToken,
          refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
          expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
        }
      : null;
  } catch {
    return null;
  }
}

export async function saveTokens(
  id: CloudProviderId,
  ownerId: string,
  tokens: CloudTokens,
): Promise<void> {
  if (!ownerId) return;
  await secureAuthStorage.setItem(key(id, ownerId), JSON.stringify(tokens)).catch(() => undefined);
}

/**
 * Forget a provider's tokens for one account.
 *
 * Unlike the reads and writes above this does **not** swallow: its callers are
 * an unlink, which should say so when it fails, and the sign-out wipe, where a
 * credential left behind is a privacy problem rather than a cosmetic one.
 */
export async function clearTokens(id: CloudProviderId, ownerId: string): Promise<void> {
  if (!ownerId) return;
  await secureAuthStorage.removeItem(key(id, ownerId));
}
