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

import type { MutationEnvelope, MutationKind } from '@baaki/core';

import { useAuth } from '@/lib/auth';

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
  /** True when there is unsent work — the UI says "syncing" rather than lying. */
  pendingCount: number;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [state, setState] = useState<SyncState>(() => syncEngine.getState());
  const signedIn = Boolean(session);
  const wasSignedIn = useRef(signedIn);

  useEffect(() => syncEngine.subscribe(setState), []);

  useEffect(() => {
    if (!signedIn) {
      // Signing out wipes the mirror: the next person to use this phone must
      // not find the previous account's ledger in it.
      if (wasSignedIn.current) void syncEngine.clear();
      wasSignedIn.current = false;
      syncEngine.stop();
      return;
    }

    wasSignedIn.current = true;
    let cancelled = false;
    void (async () => {
      await syncEngine.hydrate();
      if (cancelled) return;
      syncEngine.start();
      void syncEngine.flush();
    })();

    return () => {
      cancelled = true;
      syncEngine.stop();
    };
  }, [signedIn]);

  // Coming back to the app is the most likely moment for the world to have
  // moved on without us.
  useEffect(() => {
    if (!signedIn) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void syncEngine.flush();
    });
    return () => subscription.remove();
  }, [signedIn]);

  // And the moment a dead zone ends.
  useEffect(() => {
    if (!signedIn) return;
    const subscription = Network.addNetworkStateListener((networkState) => {
      if (networkState.isConnected) void syncEngine.flush();
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
    const timer = setTimeout(() => {
      void syncEngine.saveDraft(key, JSON.parse(serialised) as T);
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
