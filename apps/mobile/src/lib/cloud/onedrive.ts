/**
 * OneDrive (Microsoft Graph) as a receipt backup.
 *
 * Scope is `Files.ReadWrite.AppFolder`: the app gets its own sandboxed folder
 * under the user's OneDrive and can touch nothing else. A small file is written
 * with a single PUT to the item's `:/content` path, which creates the folder
 * tree implicitly — so, like Dropbox, there is no metadata pre-step.
 *
 * `offline_access` is the scope that yields a refresh token here (Microsoft
 * puts it in the scope list rather than a query param).
 */

import { authorize, isExpired, refresh, type OAuthConfig } from './oauth';
import { uploadFile } from './http';
import { clientId, isConfigured as clientConfigured } from './config';
import type { CloudProvider, CloudTokens, CloudUploadInput, CloudUploadResult } from './types';

const DISCOVERY = {
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

function config(): OAuthConfig {
  return {
    clientId: clientId('onedrive'),
    scopes: ['Files.ReadWrite.AppFolder', 'offline_access'],
    discovery: DISCOVERY,
  };
}

/** PUT bytes to the app folder under `Receipts/<name>`; returns the item id. */
async function putFile(
  tokens: CloudTokens,
  localUri: string,
  name: string,
  mimeType: string,
): Promise<string> {
  const path = `Receipts/${name}`;
  const result = await uploadFile(
    localUri,
    `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURI(path)}:/content`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      mimeType,
    },
  );
  return (result.id as string | undefined) ?? name;
}

export const oneDrive: CloudProvider = {
  id: 'onedrive',
  label: 'OneDrive',
  isConfigured: () => clientConfigured('onedrive'),
  connect: () => authorize(config()),
  ensureValid: (tokens) => (isExpired(tokens) ? refresh(config(), tokens) : Promise.resolve(tokens)),
  async upload(tokens: CloudTokens, input: CloudUploadInput): Promise<CloudUploadResult> {
    const remoteId = await putFile(tokens, input.imageUri, `${input.captureId}.jpg`, 'image/jpeg');
    await putFile(tokens, input.jsonUri, `${input.captureId}.json`, 'application/json');
    return { remoteId };
  },
};
