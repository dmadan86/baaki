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

import type { MutationEnvelope, MutationKind } from '@waves/core';

import { useAuth } from '@/lib/auth';
import { reportHandled } from '@/lib/observability';
import { clearBackupState } from '@/lib/backup/engine';
import { clearReceiptQueue, flushReceiptQueue } from '@/lib/receiptQueue';
import { clearImageCache } from '@/lib/storage/imageCache';

import { syncEngine, type SyncState } from './engine';

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
  await clearBackupState(ownerId).catch((error: unknown) => failures.push(error));
  try {
    clearImageCache();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw failures[0];
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
  // Who is signed in, held across the render in which they stop being — the
  // sign-out wipe needs the id, and by the time it runs the session is gone.
  // Null when signed out, which is also the "was anybody here?" test the old
  // boolean served.
  const lastOwnerId = useRef<string | null>(ownerId);
  // The in-flight sign-out cleanup, if any. Sign-out does not block on it, but
  // the next sign-in must: the receipt queue and image cache are device-global,
  // so a cleanup still deleting when a new account signs in would wipe the new
  // session's freshly-hydrated data. Awaiting it first serialises the two.
  const pendingCleanup = useRef<Promise<void> | null>(null);

  useEffect(() => syncEngine.subscribe(setState), []);

  useEffect(() => {
    if (!signedIn) {
      // Signing out wipes the mirror: the next person to use this phone must
      // not find the previous account's ledger in it. Worth reporting rather
      // than swallowing — a wipe that failed is a privacy problem, not a
      // cosmetic one — but not worth throwing at a screen mid-sign-out. The
      // promise is kept (never rejects — the catch resolves it) so the next
      // sign-in can await its completion before hydrating.
      const departing = lastOwnerId.current;
      if (departing !== null) {
        pendingCleanup.current = clearLocalPrivateData(departing).catch((error: unknown) =>
          reportHandled(error, 'sync.clearPrivateData'),
        );
      }
      lastOwnerId.current = null;
      syncEngine.stop();
      return;
    }

    lastOwnerId.current = ownerId;
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
      pendingCount: state.queue.length,
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
