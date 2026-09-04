/**
 * Google Drive, as a place to keep one encrypted backup file.
 *
 * The scope is `drive.appdata` and nothing else. That is the narrowest thing
 * Google offers: it grants access to a hidden per-application folder — the
 * *appDataFolder* — and to nothing whatsoever in the user's visible Drive. The
 * app cannot list their documents, cannot read a photo, cannot be tricked into
 * it, because the token was never issued for it. The wider `drive.file` scope
 * the deleted receipt-backup version used would have put the backup in the
 * user's own file list, which reads as tidier and is strictly more access than
 * this needs; `drive` (full) is never requested and never should be.
 *
 * What the user sees in exchange for the narrow scope: the file does not show
 * up in their Drive. It is still theirs — Drive's storage settings list the app
 * and offer "Delete hidden app data", and the quota it uses is their quota —
 * but they cannot open it, and it would be meaningless if they did, because it
 * is sealed with a key Google does not have (see `backup/recoveryKey.ts`).
 *
 * There is exactly one file, overwritten in place, so the appDataFolder never
 * accumulates and a restore never has to choose between candidates.
 */

import { authorize, isExpired, refresh, type OAuthConfig } from './oauth';
import { requestJson, requestRaw, requestText } from './http';
import { clientId, isConfigured as clientConfigured } from './config';
import type { CloudFile, CloudProvider, CloudTokens } from './types';

const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

/** The hidden per-app folder. Not an id we look up — Drive accepts the alias. */
const APP_DATA = 'appDataFolder';
/** The fields worth asking for; Drive returns only what it is asked for. */
const FILE_FIELDS = 'id,name,size,modifiedTime';

function config(): OAuthConfig {
  return {
    clientId: clientId('gdrive'),
    scopes: ['https://www.googleapis.com/auth/drive.appdata'],
    discovery: DISCOVERY,
    // `offline` plus a forced consent is what makes Google hand back a refresh
    // token; without it an automatic backup would stop working an hour after
    // the person connected, and they would find out weeks later.
    extraParams: { access_type: 'offline', prompt: 'consent' },
  };
}

function authHeader(tokens: CloudTokens): Record<string, string> {
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

/** Drive reports `size` as a string of bytes, and omits it for some kinds. */
function toFile(raw: Record<string, unknown>): CloudFile {
  const modified = typeof raw.modifiedTime === 'string' ? Date.parse(raw.modifiedTime) : NaN;
  const size = Number(raw.size);
  return {
    remoteId: String(raw.id ?? ''),
    name: typeof raw.name === 'string' ? raw.name : '',
    size: Number.isFinite(size) && size > 0 ? size : 0,
    modifiedAt: Number.isFinite(modified) ? modified : null,
  };
}

export const googleDrive: CloudProvider = {
  id: 'gdrive',
  label: 'Google Drive',
  isConfigured: () => clientConfigured('gdrive'),
  connect: () => authorize(config()),
  ensureValid: (tokens) =>
    isExpired(tokens) ? refresh(config(), tokens) : Promise.resolve(tokens),

  /**
   * The signed-in Google account's address, for the screen's "Google account"
   * row. `drive.about.get` is reachable under `drive.appdata`, but the exact
   * set of scopes Google accepts here has changed before, so a refusal is
   * swallowed: not knowing the address is a cosmetic loss, and widening the
   * scope to `userinfo.email` just to print a string would not be worth it.
   */
  async account(tokens: CloudTokens): Promise<string | null> {
    try {
      const about = await requestJson(
        'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)',
        { headers: authHeader(tokens) },
      );
      const user = about.user as { emailAddress?: string; displayName?: string } | undefined;
      return user?.emailAddress ?? user?.displayName ?? null;
    } catch {
      return null;
    }
  },

  async find(tokens: CloudTokens, name: string): Promise<CloudFile | null> {
    // The name is ours, not the user's, so there is nothing to escape — but the
    // query is a string Drive parses, so quote-strip anyway rather than trust
    // that it stays that way.
    const safe = name.replace(/'/g, '');
    const q = encodeURIComponent(`name='${safe}' and trashed=false`);
    const found = await requestJson(
      `https://www.googleapis.com/drive/v3/files?spaces=${APP_DATA}&q=${q}` +
        `&fields=files(${FILE_FIELDS})&pageSize=10`,
      { headers: authHeader(tokens) },
    );
    const files = (found.files as Record<string, unknown>[] | undefined) ?? [];
    // Newest wins if a past failure ever left two behind, so a restore reads
    // the most recent backup rather than whichever Drive listed first.
    const best = files
      .map(toFile)
      .filter((file) => file.remoteId.length > 0)
      .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))[0];
    return best ?? null;
  },

  async put(
    tokens: CloudTokens,
    name: string,
    content: string,
    existingId: string | null,
  ): Promise<CloudFile> {
    // An overwrite is a plain media PATCH: the name and the parent are already
    // right, and re-sending `parents` on an update is an error in Drive v3.
    if (existingId) {
      const updated = await requestRaw(
        `https://www.googleapis.com/upload/drive/v3/files/${existingId}` +
          `?uploadType=media&fields=${FILE_FIELDS}`,
        {
          method: 'PATCH',
          headers: { ...authHeader(tokens), 'Content-Type': 'application/json' },
          body: content,
        },
      );
      return toFile(updated);
    }

    // A create has to carry the metadata (the name, and the appDataFolder
    // parent) alongside the bytes, which in Drive v3 means one multipart/related
    // body with the JSON metadata as the first part and the content as the
    // second. Built by hand: the payload is a string we already hold, and
    // FormData would give us multipart/form-data, which Drive does not accept.
    const boundary = `waves-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const metadata = JSON.stringify({ name, parents: [APP_DATA] });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
      `--${boundary}--`;

    const created = await requestRaw(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`,
      {
        method: 'POST',
        headers: {
          ...authHeader(tokens),
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    return toFile(created);
  },

  read(tokens: CloudTokens, remoteId: string): Promise<string> {
    return requestText(`https://www.googleapis.com/drive/v3/files/${remoteId}?alt=media`, {
      headers: authHeader(tokens),
    });
  },

  /**
   * Hand the grant back when somebody unlinks, so "disconnect" means it in
   * Google's account settings too and not only in this app's keystore. The
   * refresh token is the one worth revoking — revoking it kills the access
   * token with it.
   */
  async revoke(tokens: CloudTokens): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    await fetch(DISCOVERY.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    });
  },
};
