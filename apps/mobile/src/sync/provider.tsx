/**
 * Wiring the sync engine to the app's lifecycle (ADR-005 / TDR §4 step 2).
 *
 * The engine syncs "on connectivity, foreground or push". This is where those
 * three become real events: AppState for foreground, expo-network for the
 * moment a dead zone ends, and a timer as the backstop for everything else.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { randomUUID } from 'expo-crypto';

import { pendingMutations } from '@waves/core';
import type { MutationEnvelope, MutationKind } from '@waves/core';

import { useAuth } from '@/lib/auth';
import { reportHandled } from '@/lib/observability';
import { clearBackupState } from '@/lib/backup/engine';
import { clearReceiptQueue, flushReceiptQueue } from '@/lib/receiptQueue';
import { forgetMessagesForOwner as forgetBankMessages } from '@/lib/smsMessageStore';
import { clearImageCache } from '@/lib/storage/imageCache';

import { syncEngine, type SyncState } from './engine';
import {
  destroyedBy,
  forgetSignOutMark,
  Retention,
  retentionExpired,
  retentionVerdict,
  takeSessionEnd,
  type SessionEnd,
} from './retention';

interface SyncContextValue extends SyncState {
  /** Queue a mutation. Resolves once it is durably on disk, not once it syncs. */
  mutate: (
    kind: MutationKind,
    groupId: string,
    payload: Record<string, unknown>,
    clientMutationId?: string,
  ) => Promise<string>;
  flush: (groupIds?: string[]) => Promise<void>;
  retry: (clientMutationId: string) => Promise<void>;
  discard: (clientMutationId: string) => Promise<void>;
  /** Forget a group locally after leaving it — see `SyncEngine.forgetGroup`. */
  forgetGroup: (groupId: string) => Promise<void>;
  /** True when there is unsent work — the UI says "syncing" rather than lying. */
  pendingCount: number;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Everything of the departing account's that lives on this device.
 *
 * `ownerId` is who is leaving, captured before the session went null — the
 * backup state is keyed by account (its tokens are a live, write-capable grant
 * into that person's Google Drive, and its recovery key opens their backup), so
 * the wipe has to be told whose. The keystore cannot be enumerated, which is
 * why this is targeted rather than a prefix sweep, and a prefix sweep would be
 * wrong anyway: a third account's settings on a shared phone are not this
 * sign-out's to delete.
 *
 * Every step is attempted even after one fails, and the first failure is
 * rethrown. A wipe that stopped halfway is a privacy problem, not a cosmetic
 * one.
 */
async function clearLocalPrivateData(ownerId: string): Promise<void> {
  const failures: unknown[] = [];
  await syncEngine.clear().catch((error: unknown) => failures.push(error));
  await clearReceiptQueue().catch((error: unknown) => failures.push(error));
  // The bank messages this phone read, bodies and all (`lib/smsMessageStore`).
  // The mirror's crypto-erase above already makes them unopenable — but
  // ciphertext nobody can read is still this person's inbox sitting on a device
  // somebody else is about to use, and the promise the Bank messages screen
  // makes is that it is not there any more.
  await forgetBankMessages(ownerId).catch((error: unknown) => failures.push(error));
  await clearBackupState(ownerId).catch((error: unknown) => failures.push(error));
  try {
    clearImageCache();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * Close out a session, destroying exactly what its ending earns.
 *
 * The two endings are not the same event, and running one wipe for both is the
 * bug `retention.ts` documents at length: a revoked token used to arrive here
 * as an indistinguishable null session and take the unsent queue with it.
 * `destroyedBy` answers the question once, in a pure function that is tested;
 * this only carries the answer out.
 *
 * A deliberate departure is unchanged, deliberately — same wipe, same order,
 * same crypto-erase. What is new is the other branch, which keeps the three
 * things nothing else in the world holds a copy of: the mutation queue, the
 * drafts, and the receipt bytes taken from a bill that is already in the bin.
 */
async function endSession(ownerId: string, reason: SessionEnd): Promise<void> {
  const scope = destroyedBy(reason);
  if (scope.unsent) {
    // `clearLocalPrivateData` is the whole wipe — queue, drafts, receipts,
    // credentials, cache and key — and the only path that reaches it.
    await clearLocalPrivateData(ownerId);
    return;
  }

  const failures: unknown[] = [];
  // Stamped with the owner in the same transaction that drops the mirror: work
  // that cannot say whose it is may never be adopted by anybody.
  await syncEngine.retainUnsent(ownerId).catch((error: unknown) => failures.push(error));
  if (scope.cache) {
    try {
      clearImageCache();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * Decide what the account now signing in inherits from the last one.
 *
 * Three answers, and two of them are cheap. Nothing held: the common case, and
 * the only one on a phone that has never lost a session. The same account back
 * inside the window: drop the stamp and let `hydrate` read its own queue.
 * Anybody else, or too long ago: destroy it *before* this session hydrates,
 * because a queue drained under the wrong session would write one person's
 * expenses into another person's groups — a worse outcome than the loss this
 * whole change exists to prevent.
 *
 * The verdict is pure and tested; the failure path is not silent, because a
 * device that cannot read its own stamp is holding data nobody can attribute.
 */
async function settleRetainedWork(signingInAs: string): Promise<void> {
  const retained = await syncEngine.retainedWork().catch((error: unknown) => {
    reportHandled(error, 'sync.readRetained');
    return null;
  });
  const verdict = retentionVerdict(retained, signingInAs, Date.now());
  if (verdict === Retention.Nothing || !retained) return;
  if (verdict === Retention.Adopt) {
    await syncEngine.adoptRetained().catch((error: unknown) => {
      reportHandled(error, 'sync.adoptRetained');
    });
    return;
  }
  await clearLocalPrivateData(retained.ownerId).catch((error: unknown) => {
    reportHandled(error, 'sync.discardRetained');
  });
}

/**
 * A launch with nobody signed in, where the last session ended on its own.
 *
 * This is the only moment the window in `retention.ts` can be enforced for
 * somebody who never comes back: every other check hangs off a sign-in, and a
 * phone left in a drawer has none. Anything still held past the window goes,
 * under the id it was stamped with.
 */
async function sweepExpiredRetention(): Promise<void> {
  const retained = await syncEngine.retainedWork().catch(() => null);
  if (!retained || !retentionExpired(retained, Date.now())) return;
  await clearLocalPrivateData(retained.ownerId);
}

/**
 * Send whatever receipt captures are still parked on this device.
 *
 * A receipt is the one thing the app takes from somebody that it cannot re-ask
 * for — the bill is in the bin by the time the upload fails — so an interrupted
 * upload has to finish itself. The bytes and the queue entry are already on
 * disk (see `receiptQueue`); this is what picks them up again, and it lives
 * here rather than on the expense screen because the three moments that matter
 * are the three this provider already listens for: the app launching into a
 * signed-in session, coming back to the foreground, and finding a network. None
 * of them involve the expense being on screen, and the old wiring — a `useEffect`
 * inside the receipts gallery — meant a person who added a receipt and walked
 * away had nothing running to send it.
 *
 * Everything is best-effort and nothing throws into a screen: a capture that
 * cannot be sent stays in the queue, visible as an unsent tile with a retry.
 */
async function resumeReceiptUploads(): Promise<void> {
  try {
    const result = await flushReceiptQueue();
    // Each upload recorded an attachment row server-side; pull it down so the
    // optimistic tile is replaced by the real receipt rather than doubling it.
    if (result.uploadedExpenseIds.length > 0) await syncEngine.flush();
  } catch (error) {
    reportHandled(error, 'sync.resumeReceiptUploads');
  }
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [state, setState] = useState<SyncState>(() => syncEngine.getState());
  const signedIn = Boolean(session);
  const ownerId = session?.user?.id ?? null;
  // Who is signed in, held across the render in which they stop being — both
  // endings need the id (one to wipe under, one to stamp the hold with), and by
  // the time either runs the session is gone. Null when signed out, which is
  // also the "was anybody here?" test the old boolean served.
  const lastOwnerId = useRef<string | null>(ownerId);
  // The in-flight cleanup, if any — the wipe, the retain, or the expiry sweep a
  // signed-out launch runs. Leaving does not block on it, but the next sign-in
  // must: the receipt queue and image cache are device-global, so a cleanup
  // still deleting when a new account signs in would wipe the new session's
  // freshly-hydrated data. Awaiting it first serialises the two.
  const pendingCleanup = useRef<Promise<void> | null>(null);

  useEffect(() => syncEngine.subscribe(setState), []);

  useEffect(() => {
    if (!signedIn) {
      // The session is gone — but *why* it is gone decides what may be deleted,
      // and this is the last place that knows. `takeSessionEnd` spends the mark
      // `lib/auth`'s `signOut` leaves; anything unmarked is a session nobody
      // asked to end, and keeps the work that has reached nobody (retention.ts).
      //
      // Worth reporting rather than swallowing — a wipe that failed is a privacy
      // problem, not a cosmetic one — but not worth throwing at a screen
      // mid-sign-out. The promise is kept (never rejects — the catch resolves
      // it) so the next sign-in can await its completion before hydrating.
      const departing = lastOwnerId.current;
      if (departing !== null) {
        pendingCleanup.current = endSession(departing, takeSessionEnd()).catch((error: unknown) =>
          reportHandled(error, 'sync.endSession'),
        );
      } else {
        // A launch onto the sign-in door. The one moment a hold left by a
        // session that ended months ago, on a phone nobody came back to, can be
        // noticed at all.
        pendingCleanup.current = sweepExpiredRetention().catch((error: unknown) =>
          reportHandled(error, 'sync.sweepRetention'),
        );
      }
      lastOwnerId.current = null;
      syncEngine.stop();
      return;
    }

    lastOwnerId.current = ownerId;
    // A mark that was never spent — a `signOut` that threw before the session
    // actually ended — must not sit armed waiting for the next revoked token.
    forgetSignOutMark();
    let cancelled = false;
    void (async () => {
      // A prior sign-out's cleanup may still be deleting the device-global
      // receipt queue / image cache. Let it finish before this session hydrates,
      // or it would delete data the new account just wrote.
      const priorCleanup = pendingCleanup.current;
      if (priorCleanup) {
        await priorCleanup;
        pendingCleanup.current = null;
        if (cancelled) return;
      }
      // Before anything is read off disk: is what is on disk this account's?
      // A queue held for somebody else is destroyed here, while there is still
      // nothing of this session's to confuse it with — and crucially before
      // `flush`, which would otherwise send the previous owner's mutations
      // under this session's token.
      if (ownerId !== null) await settleRetainedWork(ownerId);
      if (cancelled) return;
      // Nothing awaits this, so anything thrown here would surface as an
      // uncaught promise rejection over whatever screen happens to be up.
      // `flush` hydrates too, and records the failure where the banner can
      // read it.
      await syncEngine.hydrate().catch((error: unknown) => {
        reportHandled(error, 'sync.hydrate');
      });
      if (cancelled) return;
      syncEngine.start();
      void syncEngine.flush();
      // Launch is the moment an upload the app was killed mid-way through gets
      // picked back up. It runs after the wipe-then-hydrate dance above, so a
      // previous account's cleanup can never delete the bytes this one is sending.
      void resumeReceiptUploads();
    })();

    return () => {
      cancelled = true;
      syncEngine.stop();
    };
    // `ownerId` is only recorded for the wipe, but it is a render value read in
    // here, so it belongs in the list. It changes exactly when `signedIn` does
    // — or when one account is swapped for another without a signed-out frame
    // between, which is the case the ref exists to survive.
  }, [signedIn, ownerId]);

  // Coming back to the app is the most likely moment for the world to have
  // moved on without us.
  useEffect(() => {
    if (!signedIn) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void syncEngine.flush();
        void resumeReceiptUploads();
      }
    });
    return () => subscription.remove();
  }, [signedIn]);

  // And the moment a dead zone ends.
  useEffect(() => {
    if (!signedIn) return;
    const subscription = Network.addNetworkStateListener((networkState) => {
      if (networkState.isConnected) {
        void syncEngine.flush();
        void resumeReceiptUploads();
      }
    });
    return () => subscription.remove();
  }, [signedIn]);

  const mutate = useCallback(
    async (
      kind: MutationKind,
      groupId: string,
      payload: Record<string, unknown>,
      clientMutationId?: string,
    ): Promise<string> => {
      const envelope: MutationEnvelope = {
        clientMutationId: clientMutationId ?? randomUUID(),
        kind,
        groupId,
        clientCreatedAt: new Date().toISOString(),
        payload,
      };
      await syncEngine.enqueue(envelope);
      return envelope.clientMutationId;
    },
    [],
  );

  const value = useMemo<SyncContextValue>(
    () => ({
      ...state,
      mutate,
      flush: (groupIds?: string[]) => syncEngine.flush({ groupIds }),
      retry: (id: string) => syncEngine.retry(id),
      discard: (id: string) => syncEngine.discard(id),
      forgetGroup: (groupId: string) => syncEngine.forgetGroup(groupId),
      // What is genuinely still on its way. A refused mutation stays in the
      // queue so its row stays on screen, but it is not in flight — counting it
      // as pending would show a "sending…" that never finishes.
      pendingCount: pendingMutations(state.queue).length,
    }),
    [state, mutate],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (!value) throw new Error('useSync must be used inside SyncProvider');
  return value;
}

/**
 * ADR-005: drafts autosave on every keystroke, so a crash mid-entry costs
 * nothing. Writes are debounced only enough to avoid one disk write per
 * character; the last value always lands.
 */
export function useDraft<T>(key: string, value: T, options: { enabled?: boolean } = {}): void {
  const enabled = options.enabled ?? true;
  // Serialised rather than held in a ref: a form rebuilds its value object on
  // every render, so depending on the object itself would reset the debounce
  // timer forever and the draft would never actually be written.
  const serialised = useMemo(() => JSON.stringify(value), [value]);

  useEffect(() => {
    if (!enabled) return;
    if (serialised === undefined) return;
    const timer = setTimeout(() => {
      // A draft is a convenience. Losing one to a busy disk is a shame; showing
      // somebody a crash dialog in the middle of typing an expense is worse.
      void syncEngine
        .saveDraft(key, JSON.parse(serialised) as T)
        .catch((error: unknown) => reportHandled(error, 'sync.saveDraft'));
    }, 300);
    return () => clearTimeout(timer);
  }, [key, serialised, enabled]);
}

/** Read a saved draft once, on mount. */
export function useRestoredDraft<T>(key: string): { draft: T | null; loading: boolean } {
  const [draft, setDraft] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void syncEngine
      .readDraft<T>(key)
      .then((value) => {
        if (active) setDraft(value);
      })
      .catch((error: unknown) => reportHandled(error, 'sync.readDraft'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [key]);

  return { draft, loading };
}

export function clearDraft(key: string): Promise<void> {
  return syncEngine.clearDraft(key);
}
