/**
 * Box as a receipt backup.
 *
 * Box differs from the other three in two ways the shared plumbing has to bend
 * around. Its folders are not implicit: a file is uploaded *into* a folder id,
 * so the "Baaki Receipts" folder is created (or found, on the 409 the create
 * returns when it already exists) before the first upload. And its upload is
 * `multipart/form-data` — a JSON `attributes` part naming the file and its
 * parent, plus the `file` part — not the raw body Drive/Dropbox/OneDrive take.
 *
 * Scopes are configured on the Box app itself rather than requested in the URL,
 * so the authorize call sends none; the flow is otherwise the same PKCE dance.
 */

import { authorize, isExpired, refresh, type OAuthConfig } from './oauth';
import { CloudHttpError, requestJson, uploadMultipart } from './http';
import { BACKUP_FOLDER, clientId, isConfigured as clientConfigured } from './config';
import type { CloudProvider, CloudTokens, CloudUploadInput, CloudUploadResult } from './types';

const DISCOVERY = {
  authorizationEndpoint: 'https://account.box.com/api/oauth2/authorize',
  tokenEndpoint: 'https://api.box.com/oauth2/token',
};

function config(): OAuthConfig {
  return {
    clientId: clientId('box'),
    // Box grants access by the app's configured scopes, not per-request ones.
    scopes: [],
    discovery: DISCOVERY,
  };
}

function authHeader(tokens: CloudTokens): Record<string, string> {
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

/** Create the "Baaki Receipts" folder at the account root, or find it; its id. */
async function ensureFolder(tokens: CloudTokens): Promise<string> {
  try {
    const created = await requestJson('https://api.box.com/2.0/folders', {
      method: 'POST',
      headers: authHeader(tokens),
      body: { name: BACKUP_FOLDER, parent: { id: '0' } },
    });
    return created.id as string;
  } catch (error) {
    // Already there: Box returns 409 with the existing folder's id in the
    // conflict, so a second run reuses it rather than failing.
    if (error instanceof CloudHttpError && error.status === 409) {
      try {
        const body = JSON.parse(error.body) as {
          context_info?: { conflicts?: { id: string }[] };
        };
        const existing = body.context_info?.conflicts?.[0]?.id;
        if (existing) return existing;
      } catch {
        // fall through to rethrow
      }
    }
    throw error;
  }
}

/** Upload one file into the folder; returns Box's file id (or the name on 409). */
async function putFile(
  tokens: CloudTokens,
  folderId: string,
  localUri: string,
  name: string,
  mimeType: string,
): Promise<string> {
  try {
    const result = await uploadMultipart(localUri, 'https://upload.box.com/api/2.0/files/content', {
      method: 'POST',
      headers: authHeader(tokens),
      mimeType,
      fieldName: 'file',
      parameters: { attributes: JSON.stringify({ name, parent: { id: folderId } }) },
    });
    const entries = (result.entries as { id: string }[] | undefined) ?? [];
    return entries[0]?.id ?? name;
  } catch (error) {
    // A name already in the folder is a receipt already backed up — treat it as
    // done rather than failing the whole pass on a duplicate.
    if (error instanceof CloudHttpError && error.status === 409) return name;
    throw error;
  }
}

export const box: CloudProvider = {
  id: 'box',
  label: 'Box',
  isConfigured: () => clientConfigured('box'),
  connect: () => authorize(config()),
  ensureValid: (tokens) =>
    isExpired(tokens) ? refresh(config(), tokens) : Promise.resolve(tokens),
  async upload(tokens: CloudTokens, input: CloudUploadInput): Promise<CloudUploadResult> {
    const folderId = await ensureFolder(tokens);
    const remoteId = await putFile(
      tokens,
      folderId,
      input.imageUri,
      `${input.captureId}.jpg`,
      'image/jpeg',
    );
    await putFile(tokens, folderId, input.jsonUri, `${input.captureId}.json`, 'application/json');
    return { remoteId };
  },
};
