/**
 * The shape a personal-cloud backend is reduced to.
 *
 * Only Google Drive implements this today, and that is deliberate — but the
 * seam stays because the interesting part of "back up somewhere that is yours"
 * is the *somewhere*, and Dropbox, OneDrive and Box are the same three calls
 * with different endpoints. An earlier version of this file carried all four
 * (PR #164, deleted by #393 when receipt images moved to R2); this one is the
 * ledger-backup half of that, narrowed to one provider so there is exactly one
 * OAuth console dependency to set up rather than four.
 *
 * The interface is deliberately not about images. A personal backup is one
 * small named blob of text that gets read back whole, so the provider only has
 * to find it, write it, and hand it back — no folder trees, no thumbnails, no
 * partial reads.
 */

/** Every backend this build knows how to talk to. One, for now. */
export type CloudProviderId = 'gdrive';

export const CLOUD_PROVIDER_IDS: readonly CloudProviderId[] = ['gdrive'];

/** OAuth tokens for one provider, as stored in the keystore. */
export interface CloudTokens {
  readonly accessToken: string;
  /** Null when the provider issued no refresh token (re-auth needed on expiry). */
  readonly refreshToken: string | null;
  /** Epoch ms the access token expires, or null when the provider didn't say. */
  readonly expiresAt: number | null;
}

/** One file in the provider's app storage, as the backup engine sees it. */
export interface CloudFile {
  /** The provider's own id — the handle for a later read or overwrite. */
  readonly remoteId: string;
  readonly name: string;
  /** Bytes, or 0 when the provider did not report a size. */
  readonly size: number;
  /** Epoch ms of the last write, or null when the provider did not say. */
  readonly modifiedAt: number | null;
}

export interface CloudProvider {
  readonly id: CloudProviderId;
  readonly label: string;
  /** False when this build has no client id — "Connect" is inert, not broken. */
  isConfigured(): boolean;
  /** Interactive OAuth. Resolves to tokens, or null if the user cancelled. */
  connect(): Promise<CloudTokens | null>;
  /** Tokens good to use now, refreshed first if they are near expiry. */
  ensureValid(tokens: CloudTokens): Promise<CloudTokens>;
  /**
   * Which account these tokens belong to, for the "Google account" row.
   * Null when the provider will not say under the scopes we hold — the screen
   * then names the provider without naming the person, rather than guessing.
   */
  account(tokens: CloudTokens): Promise<string | null>;
  /** The named file in the app's private storage, or null when absent. */
  find(tokens: CloudTokens, name: string): Promise<CloudFile | null>;
  /**
   * Write `content` as `name`. `existingId` overwrites that file in place;
   * null creates a new one. Resolves with the stored file.
   */
  put(
    tokens: CloudTokens,
    name: string,
    content: string,
    existingId: string | null,
  ): Promise<CloudFile>;
  /** Read a file's whole text back. */
  read(tokens: CloudTokens, remoteId: string): Promise<string>;
  /** Best-effort token revocation on unlink. Optional; failure is not fatal. */
  revoke?(tokens: CloudTokens): Promise<void>;
}
