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
import type { CloudProviderId } from '../cloud/types';
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
import { backupNonce, openBackup, sealBackup } from './recoveryKey';
import type { LastBackup } from './settings';

/** The one file in the provider's app-private storage. Overwritten in place. */
export const BACKUP_FILE_NAME = 'waves-personal-backup.json';

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
 * Tokens good to use now, refreshed if stale and written back so the next run
 * starts from the fresh pair. Null when there is nothing linked; throws only if
 * the refresh itself fails in a way worth reporting.
 */
async function freshTokens(id: CloudProviderId) {
  const stored = await loadTokens(id);
  if (!stored) return null;
  const provider = providerFor(id);
  const tokens = await provider.ensureValid(stored);
  if (tokens !== stored) await saveTokens(id, tokens);
  return tokens;
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

    const tokens = await freshTokens(PRIMARY_PROVIDER).catch(() => null);
    if (!tokens) return { ok: false, refusal: 'not-connected' };

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
    try {
      const existing = await provider.find(tokens, BACKUP_FILE_NAME);
      const stored = await provider.put(
        tokens,
        BACKUP_FILE_NAME,
        content,
        existing?.remoteId ?? null,
      );
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
        await clearTokens(PRIMARY_PROVIDER);
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

  const tokens = await freshTokens(PRIMARY_PROVIDER).catch(() => null);
  if (!tokens) return { ok: false, refusal: 'not-connected' };

  try {
    const file = await provider.find(tokens, BACKUP_FILE_NAME);
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
      await clearTokens(PRIMARY_PROVIDER);
      return { ok: false, refusal: 'auth' };
    }
    throw error;
  }
}
