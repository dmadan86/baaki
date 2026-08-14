/**
 * The shape every personal-cloud backend is reduced to.
 *
 * Drive, Dropbox and OneDrive disagree about almost everything — how you
 * authorise, where a file goes, what an upload returns — but the backup queue
 * should not have to care. Each provider implements this interface, and the
 * queue talks only to the interface: connect once, keep the tokens fresh,
 * upload an image and its sidecar, get back an id it can remember.
 */

export type CloudProviderId = 'gdrive' | 'dropbox' | 'onedrive';

export const CLOUD_PROVIDER_IDS: readonly CloudProviderId[] = ['gdrive', 'dropbox', 'onedrive'];

/** OAuth tokens for one provider, as stored in the keystore. */
export interface CloudTokens {
  readonly accessToken: string;
  /** Null when the provider issued no refresh token (re-auth needed on expiry). */
  readonly refreshToken: string | null;
  /** Epoch ms the access token expires, or null when the provider didn't say. */
  readonly expiresAt: number | null;
}

/** One receipt to back up: the local files plus what to name them remotely. */
export interface CloudUploadInput {
  readonly captureId: string;
  /** Local file URI of the receipt image. */
  readonly imageUri: string;
  /** Local file URI of the JSON sidecar. */
  readonly jsonUri: string;
}

export interface CloudUploadResult {
  /** The provider's id for the uploaded image — remembered for de-dup/delete. */
  readonly remoteId: string;
}

export interface CloudProvider {
  readonly id: CloudProviderId;
  readonly label: string;
  /** False when this build has no client id for the provider — "Connect" is inert. */
  isConfigured(): boolean;
  /** Interactive OAuth. Resolves to tokens, or null if the user cancelled. */
  connect(): Promise<CloudTokens | null>;
  /** Return tokens good to use now, refreshing first if they are near expiry. */
  ensureValid(tokens: CloudTokens): Promise<CloudTokens>;
  /** Upload the image and its sidecar; resolve with the image's remote id. */
  upload(tokens: CloudTokens, input: CloudUploadInput): Promise<CloudUploadResult>;
}

/** Wi‑Fi only, or Wi‑Fi and mobile data. Defaults to Wi‑Fi to protect data plans. */
export type BackupNetworkPolicy = 'wifi' | 'any';
