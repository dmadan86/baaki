/**
 * The pump: take the personal ledger, seal it, put it in the user's Drive — and
 * on the way back, fetch it, open it, and say what a restore would write.
 *
 * No React and no hooks, so the whole flow can be reasoned about (and most of
 * it tested) without a renderer. What it does not own is *what* to back up: the
 * records come in from the caller, because the only honest source for them is
 * the mirror with the offline queue replayed on top, and that is a hook.
 *
 * Two kinds of "did not happen" are kept apart on purpose. A **refusal** is a
 * state the person can act on — no Drive connected, no key, holding for Wi‑Fi —
 * and is returned as a value so the screen can say which one in their own
 * words. A **failure** is a thrown error carrying a provider message that must
 * never reach a screen; it goes through `friendlyError` at the call site, which
 * reports the original and returns a sentence.
 */

import * as Network from 'expo-network';

import { networkAllows, type SyncNetworkPreference } from '../syncNetwork';
import { isAuthFailure } from '../cloud/http';
import { providerFor } from '../cloud/providers';
import { clearTokens, loadTokens, saveTokens } from '../cloud/tokens';
import type { CloudProviderId, CloudTokens } from '../cloud/types';
import {
  backupAad,
  buildBody,
  buildFile,
  parseBody,
  parseFile,
  planRestore,
  type BackupBody,
  type RestorePlan,
  type SourceRecord,
} from './payload';
import { backupNonce, clearRecoveryKey, openBackup, sealBackup } from './recoveryKey';
import { clearBackupSettings, type LastBackup } from './settings';

/**
 * The one file in the provider's app-private storage, per account. Overwritten
 * in place, so the appDataFolder never accumulates.
 *
 * The owner id is in the name because scoping the *local* keys is not enough:
 * two different Waves accounts that link the same Google account share one
 * appDataFolder, and a fixed filename would have the second silently overwrite
 * the first's backup — sealed under a key whose AAD no longer matches, so the
 * first person could never open what was left of theirs. Nothing has ever run
 * against Google (this build has no OAuth client ids), so there is no old
 * fixed-name file anywhere to migrate; a shipped build would have needed one.
 */
export function backupFileName(ownerId: string): string {
  // The id is a UUID from Supabase, but the name goes into a Drive query, so it
  // is narrowed here rather than trusted to stay one.
  const safe = ownerId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `waves-personal-backup-${safe}.json`;
}

/** Only Drive today; named so the rest of the module never hardcodes it. */
export const PRIMARY_PROVIDER: CloudProviderId = 'gdrive';

/** Where a run has got to, for the progress line under "Back up now". */
export type BackupPhase = 'collecting' | 'sealing' | 'uploading';

/** A run that did not happen, and why — each one has a different way out. */
export type BackupRefusal =
  /** Another run is already going. */
  | 'busy'
  /** This build has no OAuth client id for the provider. */
  | 'not-configured'
  /** No Drive account linked. */
  | 'not-connected'
  /** No recovery key on this device — nothing to seal (or open) with. */
  | 'no-key'
  /** No usable connection at all. */
  | 'offline'
  /** Connected, but not over a network the person allows backups on. */
  | 'network-policy'
  /** The stored tokens were rejected; the link has to be made again. */
  | 'auth'
  /** Nothing on Drive to restore from. */
  | 'no-backup';

export type BackupResult =
  | { readonly ok: true; readonly last: LastBackup }
  | { readonly ok: false; readonly refusal: BackupRefusal };

export interface BackupRunInput {
  readonly ownerId: string;
  readonly records: readonly SourceRecord[];
  /** The 32-byte recovery key. See `recoveryKey.ts` for why it is user-held. */
  readonly key: Uint8Array;
  readonly network: SyncNetworkPreference;
  /**
   * True for "Back up now". A person tapping the button has made the data-plan
   * decision themselves, so the Wi‑Fi gate is not applied to them — it exists to
   * stop the *automatic* schedule spending mobile data unasked. Being offline
   * still stops both: there is nowhere for the bytes to go.
   */
  readonly manual: boolean;
  readonly onPhase?: (phase: BackupPhase) => void;
}

// One run at a time, process-wide. The automatic check and a button press can
// land together (the app foregrounds, the person taps immediately), and two
// concurrent writes to one Drive file is a lost update at best.
let running = false;

/** Whether a run is in flight — the screen disables the button on it. */
export function isRunning(): boolean {
  return running;
}

async function connection(): Promise<{ online: boolean; type: Network.NetworkStateType | null }> {
  try {
    const state = await Network.getNetworkStateAsync();
    return {
      // `isInternetReachable` is undefined on some platforms; a connected
      // interface is the best signal there, and a dead request fails anyway.
      online: state.isInternetReachable ?? state.isConnected ?? true,
      type: state.type ?? null,
    };
  } catch {
    // Fail open, like the sync engine: better an attempt that fails than a
    // backup silently never running because the network module would not say.
    return { online: true, type: null };
  }
}

/**
 * The three answers to "can we talk to the provider right now", kept apart.
 *
 * `none` and `auth` used to be the same answer, because the refresh was wrapped
 * in a `.catch(() => null)`: a refresh token the user had revoked came back as
 * "nothing is linked", the dead tokens stayed on disk, and the screen offered
 * connect-from-scratch as the remedy for a link that needed re-authorising.
 * Two different states with two different ways out, so: two values.
 */
type TokenLookup =
  | { readonly kind: 'ok'; readonly tokens: CloudTokens }
  | { readonly kind: 'none' }
  | { readonly kind: 'auth' };

/**
 * Tokens good to use now, refreshed if stale and written back so the next run
 * starts from the fresh pair.
 *
 * Throws for a transport failure — a token endpoint that timed out is not a
 * dead link, and the caller launders the message before anybody sees it.
 */
async function freshTokens(id: CloudProviderId, ownerId: string): Promise<TokenLookup> {
  const stored = await loadTokens(id, ownerId);
  if (!stored) return { kind: 'none' };
  try {
    const tokens = await providerFor(id).ensureValid(stored);
    if (tokens !== stored) await saveTokens(id, ownerId, tokens);
    return { kind: 'ok', tokens };
  } catch (error) {
    if (!isAuthFailure(error)) throw error;
    // The grant is gone for good. Drop the tokens so the screen stops offering
    // a retry that cannot work, and say which of the two states this is.
    await clearTokens(id, ownerId).catch(() => undefined);
    return { kind: 'auth' };
  }
}

/**
 * Everything this device remembers about one account's backups: the provider
 * tokens, the recovery key, and the schedule / last-backup / key-seen
 * preferences.
 *
 * Called on unlink and — the case that matters — from the sign-out wipe in
 * `sync/provider.tsx`. Until this existed, B signing in after A on a shared
 * phone found A's Google account linked, held A's recovery key, and inherited
 * A's schedule; worse, B's first backup would have found A's file and
 * overwritten it. Every piece is attempted even after one fails and the first
 * failure is rethrown, matching `clearLocalPrivateData`: a credential left
 * behind by a half-finished wipe is a privacy problem, not a cosmetic one.
 *
 * The file on Drive is deliberately untouched. It is the user's, it is
 * unreadable without the key they wrote down, and the point of it is to outlive
 * this app's state.
 */
export async function clearBackupState(ownerId: string): Promise<void> {
  if (!ownerId) return;
  const failures: unknown[] = [];
  await clearTokens(PRIMARY_PROVIDER, ownerId).catch((error: unknown) => failures.push(error));
  await clearRecoveryKey(ownerId).catch((error: unknown) => failures.push(error));
  await clearBackupSettings(ownerId).catch((error: unknown) => failures.push(error));
  if (failures.length > 0) throw failures[0];
}

/**
 * Back the personal ledger up. Resolves with a refusal rather than throwing for
 * anything the person can fix; throws for a genuine transport or provider
 * failure, whose message the caller must launder before showing it.
 */
export async function runBackup(input: BackupRunInput): Promise<BackupResult> {
  if (running) return { ok: false, refusal: 'busy' };
  // Claimed before the first await, so two triggers cannot both pass the check.
  running = true;
  try {
    const provider = providerFor(PRIMARY_PROVIDER);
    if (!provider.isConfigured()) return { ok: false, refusal: 'not-configured' };
    if (input.key.length === 0) return { ok: false, refusal: 'no-key' };

    const net = await connection();
    if (!net.online) return { ok: false, refusal: 'offline' };
    if (!input.manual && !networkAllows(input.network, net.type)) {
      return { ok: false, refusal: 'network-policy' };
    }

    const lookup = await freshTokens(PRIMARY_PROVIDER, input.ownerId);
    if (lookup.kind !== 'ok') {
      return { ok: false, refusal: lookup.kind === 'auth' ? 'auth' : 'not-connected' };
    }
    const tokens = lookup.tokens;

    input.onPhase?.('collecting');
    const body = buildBody(input.ownerId, input.records, new Date());

    input.onPhase?.('sealing');
    const sealed = sealBackup(
      input.key,
      backupNonce(),
      JSON.stringify(body),
      backupAad(input.ownerId),
    );
    const content = JSON.stringify(buildFile(sealed, body.createdAt));

    input.onPhase?.('uploading');
    const fileName = backupFileName(input.ownerId);
    try {
      const existing = await provider.find(tokens, fileName);
      const stored = await provider.put(tokens, fileName, content, existing?.remoteId ?? null);
      return {
        ok: true,
        last: {
          at: Date.now(),
          // Drive echoes the stored size; fall back to what we sent, which is
          // the same number in bytes for an ASCII-only sealed envelope.
          size: stored.size > 0 ? stored.size : content.length,
          records: body.records.length,
        },
      };
    } catch (error) {
      // A grant that has been revoked from the Google account side comes back
      // as a 401/403 forever. Drop the dead tokens so the screen offers
      // "Connect" rather than retrying a link that no longer exists.
      if (isAuthFailure(error)) {
        await clearTokens(PRIMARY_PROVIDER, input.ownerId).catch(() => undefined);
        return { ok: false, refusal: 'auth' };
      }
      throw error;
    }
  } finally {
    running = false;
  }
}

export type RestoreScan =
  | {
      readonly ok: true;
      readonly body: BackupBody;
      readonly plan: RestorePlan;
      /** Bytes of the file as stored, for the confirmation line. */
      readonly size: number;
    }
  | { readonly ok: false; readonly refusal: BackupRefusal };

export interface RestoreScanInput {
  readonly ownerId: string;
  readonly key: Uint8Array;
  /** Every personal record id this device knows, tombstones included. */
  readonly localIds: ReadonlySet<string>;
}

/**
 * Fetch and open the backup, and work out what restoring it would write —
 * without writing anything. The screen shows the person that number and the
 * date before they commit, because "restore" is the word people are most afraid
 * of pressing.
 *
 * The network policy is deliberately not applied: a restore is always somebody
 * standing there having asked for it, usually on a phone that has just been set
 * up and may well not be on Wi‑Fi yet.
 */
export async function scanBackup(input: RestoreScanInput): Promise<RestoreScan> {
  const provider = providerFor(PRIMARY_PROVIDER);
  if (!provider.isConfigured()) return { ok: false, refusal: 'not-configured' };
  if (input.key.length === 0) return { ok: false, refusal: 'no-key' };

  const net = await connection();
  if (!net.online) return { ok: false, refusal: 'offline' };

  const lookup = await freshTokens(PRIMARY_PROVIDER, input.ownerId);
  if (lookup.kind !== 'ok') {
    return { ok: false, refusal: lookup.kind === 'auth' ? 'auth' : 'not-connected' };
  }
  const tokens = lookup.tokens;

  try {
    const file = await provider.find(tokens, backupFileName(input.ownerId));
    if (!file) return { ok: false, refusal: 'no-backup' };

    const envelope = parseFile(await provider.read(tokens, file.remoteId));
    // Throws on the wrong key (the AEAD tag fails) — the screen turns that into
    // "that key does not open this backup", which is the whole diagnosis.
    const plain = openBackup(input.key, envelope.sealed, backupAad(input.ownerId));
    const body = parseBody(plain, input.ownerId);
    return {
      ok: true,
      body,
      plan: planRestore(input.localIds, body),
      size: file.size > 0 ? file.size : 0,
    };
  } catch (error) {
    if (isAuthFailure(error)) {
      await clearTokens(PRIMARY_PROVIDER, input.ownerId).catch(() => undefined);
      return { ok: false, refusal: 'auth' };
    }
    throw error;
  }
}
