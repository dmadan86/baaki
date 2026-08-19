/**
 * Google Drive as a receipt backup.
 *
 * Scope is `drive.file`, the narrow one: the app can only see and touch files it
 * created, never the rest of the user's Drive. Receipts go into a "Baaki
 * Receipts" folder created on first upload; because of the scope, the folder
 * search only ever returns that folder, so there is nothing to collide with.
 *
 * A file is made in two steps — create the metadata (name + parent), then send
 * the bytes to the upload endpoint for that id — so the image lands already
 * named and filed rather than as an "Untitled" the user has to sort out.
 */

import { authorize, isExpired, refresh, type OAuthConfig } from './oauth';
import { requestJson, uploadFile } from './http';
import { BACKUP_FOLDER, clientId, isConfigured as clientConfigured } from './config';
import type {
  CloudProvider,
  CloudShareRef,
  CloudShareResult,
  CloudTokens,
  CloudUploadInput,
  CloudUploadResult,
} from './types';

const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

function config(): OAuthConfig {
  return {
    clientId: clientId('gdrive'),
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    discovery: DISCOVERY,
    // `offline` + a forced consent is what makes Google hand back a refresh
    // token; without it the backup would stop working an hour after connecting.
    extraParams: { access_type: 'offline', prompt: 'consent' },
  };
}

function authHeader(tokens: CloudTokens): Record<string, string> {
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

/** Find the "Baaki Receipts" folder or create it; returns its id. */
async function ensureFolder(tokens: CloudTokens): Promise<string> {
  const query = encodeURIComponent(
    `name='${BACKUP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const found = await requestJson(
    `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id)`,
    { headers: authHeader(tokens) },
  );
  const files = (found.files as { id: string }[] | undefined) ?? [];
  if (files[0]?.id) return files[0].id;

  const created = await requestJson('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: authHeader(tokens),
    body: { name: BACKUP_FOLDER, mimeType: 'application/vnd.google-apps.folder' },
  });
  return created.id as string;
}

/** Create a named file in the folder, then stream its bytes in. Returns the id. */
async function putFile(
  tokens: CloudTokens,
  folderId: string,
  localUri: string,
  name: string,
  mimeType: string,
): Promise<string> {
  const meta = await requestJson('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: authHeader(tokens),
    body: { name, parents: [folderId] },
  });
  const id = meta.id as string;
  await uploadFile(
    localUri,
    `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
    {
      method: 'PATCH',
      headers: authHeader(tokens),
      mimeType,
    },
  );
  return id;
}

export const googleDrive: CloudProvider = {
  id: 'gdrive',
  label: 'Google Drive',
  isConfigured: () => clientConfigured('gdrive'),
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
  /**
   * Open the receipt to anyone with the link, view-only, and hand back that link
   * (E3). Two calls: grant a `reader`/`anyone` permission on the file, then read
   * its `webViewLink`.
   *
   * The `drive.file` scope this provider already holds is enough — it grants
   * full control of files the app itself created, permission changes included,
   * without widening access to the rest of the user's Drive. The image never
   * passes through Waves; the link points straight at the owner's own Drive.
   */
  async share(tokens: CloudTokens, ref: CloudShareRef): Promise<CloudShareResult> {
    await requestJson(`https://www.googleapis.com/drive/v3/files/${ref.remoteId}/permissions`, {
      method: 'POST',
      headers: authHeader(tokens),
      body: { role: 'reader', type: 'anyone' },
    });
    const meta = await requestJson(
      `https://www.googleapis.com/drive/v3/files/${ref.remoteId}?fields=webViewLink`,
      { headers: authHeader(tokens) },
    );
    const url = meta.webViewLink as string | undefined;
    return url ? { url } : { unsupported: true };
  },
};
