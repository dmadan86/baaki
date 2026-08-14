/**
 * Dropbox as a receipt backup.
 *
 * Dropbox takes the upload as raw bytes with the destination path in a
 * `Dropbox-API-Arg` header, so there is no metadata pre-step — the path names
 * the file and the folder is created implicitly. `token_access_type=offline` on
 * the authorize call is Dropbox's switch for handing back a refresh token, the
 * equivalent of Google's `access_type=offline`.
 *
 * Scope is `files.content.write` (plus read for completeness); the app can only
 * touch what it writes.
 */

import { authorize, isExpired, refresh, type OAuthConfig } from './oauth';
import { uploadFile } from './http';
import { BACKUP_FOLDER, clientId, isConfigured as clientConfigured } from './config';
import type { CloudProvider, CloudTokens, CloudUploadInput, CloudUploadResult } from './types';

const DISCOVERY = {
  authorizationEndpoint: 'https://www.dropbox.com/oauth2/authorize',
  tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
};

function config(): OAuthConfig {
  return {
    clientId: clientId('dropbox'),
    scopes: ['files.content.write', 'files.content.read'],
    discovery: DISCOVERY,
    extraParams: { token_access_type: 'offline' },
  };
}

async function putFile(
  tokens: CloudTokens,
  localUri: string,
  name: string,
  mimeType: string,
): Promise<string> {
  const arg = {
    path: `/${BACKUP_FOLDER}/${name}`,
    // Overwrite so a re-scan of the same capture replaces cleanly rather than
    // piling up "(1)" copies.
    mode: 'overwrite',
    mute: true,
    autorename: false,
  };
  const result = await uploadFile(localUri, 'https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Dropbox-API-Arg': JSON.stringify(arg),
    },
    // Dropbox requires an octet-stream content type on the content endpoint.
    mimeType: 'application/octet-stream',
  });
  return (result.id as string | undefined) ?? name;
}

export const dropbox: CloudProvider = {
  id: 'dropbox',
  label: 'Dropbox',
  isConfigured: () => clientConfigured('dropbox'),
  connect: () => authorize(config()),
  ensureValid: (tokens) =>
    isExpired(tokens) ? refresh(config(), tokens) : Promise.resolve(tokens),
  async upload(tokens: CloudTokens, input: CloudUploadInput): Promise<CloudUploadResult> {
    const remoteId = await putFile(tokens, input.imageUri, `${input.captureId}.jpg`, 'image/jpeg');
    await putFile(tokens, input.jsonUri, `${input.captureId}.json`, 'application/json');
    return { remoteId };
  },
};
