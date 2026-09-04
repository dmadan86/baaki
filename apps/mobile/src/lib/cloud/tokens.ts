/**
 * Where a provider's OAuth tokens live: the OS keystore, not AsyncStorage.
 *
 * A refresh token for someone's Google Drive is exactly the kind of long-lived
 * credential the app's own session hardening moved out of plaintext, so it
 * rides the same chunked SecureStore adapter (`secureAuthStorage`) that the
 * Supabase session uses — Keychain on iOS, Keystore on Android, AsyncStorage
 * only on web where there is no keystore.
 */

import { secureAuthStorage } from '../secureStorage';
import type { CloudProviderId, CloudTokens } from './types';

const key = (id: CloudProviderId): string => `waves.cloud.tokens.${id}`;

export async function loadTokens(id: CloudProviderId): Promise<CloudTokens | null> {
  const raw = await secureAuthStorage.getItem(key(id)).catch(() => null);
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

export async function saveTokens(id: CloudProviderId, tokens: CloudTokens): Promise<void> {
  await secureAuthStorage.setItem(key(id), JSON.stringify(tokens)).catch(() => undefined);
}

export async function clearTokens(id: CloudProviderId): Promise<void> {
  await secureAuthStorage.removeItem(key(id)).catch(() => undefined);
}
