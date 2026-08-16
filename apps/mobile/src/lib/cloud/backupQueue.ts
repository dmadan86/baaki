/**
 * The pump that moves saved receipts to the user's chosen cloud.
 *
 * It is intentionally dumb and idempotent: read what the index says is still
 * pending, upload each to the primary provider, mark the outcome. It never
 * holds state of its own beyond a re-entrancy guard, so it is safe to call from
 * anywhere — after a save, when the app comes to the foreground, when the
 * network changes — and calling it when there is nothing to do costs one cheap
 * network-state read.
 *
 * The two gates that decide *whether* to run are the user's, not ours: which
 * provider is primary, and whether uploads are allowed off Wi‑Fi. Both are
 * checked here so no caller can bypass a data-plan preference by accident.
 */

import * as Network from 'expo-network';

import { markError, markSynced, pendingEntries } from '../receiptIndex';
import { providerFor } from './providers';
import { loadTokens, saveTokens } from './tokens';
import type { BackupNetworkPolicy, CloudProviderId } from './types';

export interface BackupContext {
  readonly primary: CloudProviderId | null;
  readonly policy: BackupNetworkPolicy;
}

/**
 * Why a run did nothing, or null when it uploaded (or had nothing pending).
 * Surfaced to the settings screen so "not syncing" can say why.
 */
export type BackupSkip =
  'busy' | 'no-provider' | 'not-configured' | 'not-connected' | 'offline' | 'policy' | 'auth';

export interface BackupOutcome {
  readonly uploaded: number;
  readonly skipped: BackupSkip | null;
}

/** After this many failures a receipt is left alone until something changes. */
const MAX_ATTEMPTS = 8;

// Module-level guard: only one pass runs at a time, so overlapping triggers
// (a save that lands just as the network flips) don't double-upload.
let running = false;

function nowIso(): string {
  return new Date().toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBackup(ctx: BackupContext): Promise<BackupOutcome> {
  if (running) return { uploaded: 0, skipped: 'busy' };

  // Claim the guard synchronously, before the first await, so two overlapping
  // triggers can't both pass the check above and reach the upload loop.
  running = true;
  let uploaded = 0;
  try {
    if (!ctx.primary) return { uploaded: 0, skipped: 'no-provider' };

    const provider = providerFor(ctx.primary);
    if (!provider.isConfigured()) return { uploaded: 0, skipped: 'not-configured' };

    const net = await Network.getNetworkStateAsync();
    if (!net.isConnected || net.isInternetReachable === false) {
      return { uploaded: 0, skipped: 'offline' };
    }
    if (ctx.policy === 'wifi' && net.type !== Network.NetworkStateType.WIFI) {
      return { uploaded: 0, skipped: 'policy' };
    }

    const pending = await pendingEntries();
    if (pending.length === 0) return { uploaded: 0, skipped: null };

    const stored = await loadTokens(ctx.primary);
    if (!stored) return { uploaded: 0, skipped: 'not-connected' };

    // Refresh once up front; every upload in this pass reuses the fresh token.
    const tokens = await provider.ensureValid(stored);
    await saveTokens(ctx.primary, tokens);

    for (const entry of pending) {
      if (entry.attempts >= MAX_ATTEMPTS) continue;
      // A receipt with no sidecar has nothing valid to upload as its metadata.
      // Mark it errored rather than skip silently: a silent `continue` leaves it
      // pending forever with no reason the settings screen can show.
      if (!entry.jsonUri) {
        await markError(
          entry.captureId,
          'This receipt is missing its saved details and cannot be backed up.',
          nowIso(),
        );
        continue;
      }
      try {
        const result = await provider.upload(tokens, {
          captureId: entry.captureId,
          imageUri: entry.imageUri,
          jsonUri: entry.jsonUri,
        });
        await markSynced(
          entry.captureId,
          { provider: ctx.primary, remoteId: result.remoteId },
          nowIso(),
        );
        uploaded += 1;
      } catch (error) {
        await markError(entry.captureId, messageOf(error), nowIso());
      }
    }
  } catch {
    // A failed refresh means the whole pass can't authenticate — leave the
    // receipts pending rather than marking each one errored for one bad token.
    return { uploaded, skipped: 'auth' };
  } finally {
    running = false;
  }

  return { uploaded, skipped: null };
}
