/**
 * The app-wide state behind receipt backup: which provider is primary, whether
 * uploads may use mobile data, which providers are connected, and how many
 * receipts are still waiting to go up.
 *
 * It also owns the *when*: a pass runs when the app comes to the foreground and
 * whenever the network changes, plus on demand right after a capture is saved.
 * Those are the moments a stuck upload can suddenly become possible — a phone
 * that walks back onto Wi‑Fi, an app reopened in signal — so they are the
 * moments to try again. Modeled on `MotionProvider`: preferences in
 * AsyncStorage, read once, written through.
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import * as Network from 'expo-network';

import { pendingCount as readPendingCount } from '../receiptIndex';
import { runBackup, type BackupContext, type BackupSkip } from './backupQueue';
import { providerFor } from './providers';
import { clearTokens, isConnected, saveTokens } from './tokens';
import {
  CLOUD_PROVIDER_IDS,
  type BackupNetworkPolicy,
  type CloudProviderId,
} from './types';

const PRIMARY_KEY = 'baaki.cloud.primary';
const POLICY_KEY = 'baaki.cloud.policy';

type ConnectedMap = Record<CloudProviderId, boolean>;

const NONE_CONNECTED: ConnectedMap = { gdrive: false, dropbox: false, onedrive: false };

interface BackupValue {
  readonly loading: boolean;
  readonly primary: CloudProviderId | null;
  readonly policy: BackupNetworkPolicy;
  readonly connected: ConnectedMap;
  readonly pending: number;
  readonly lastSkip: BackupSkip | null;
  setPrimary: (id: CloudProviderId | null) => Promise<void>;
  setPolicy: (policy: BackupNetworkPolicy) => Promise<void>;
  /** Run the OAuth flow for a provider; returns true on success. */
  connect: (id: CloudProviderId) => Promise<boolean>;
  disconnect: (id: CloudProviderId) => Promise<void>;
  /** Try to upload anything pending now. Safe to call freely. */
  kick: () => Promise<void>;
}

const BackupCtx = createContext<BackupValue | null>(null);

export function BackupProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [primary, setPrimaryState] = useState<CloudProviderId | null>(null);
  const [policy, setPolicyState] = useState<BackupNetworkPolicy>('wifi');
  const [connected, setConnected] = useState<ConnectedMap>(NONE_CONNECTED);
  const [pending, setPending] = useState(0);
  const [lastSkip, setLastSkip] = useState<BackupSkip | null>(null);

  // A ref so the AppState/network listeners always kick with current settings
  // without being torn down and re-added on every preference change. Kept in
  // sync from an effect (never written during render); the setters below also
  // write it eagerly so a kick fired right after a change sees the new value.
  const ctxRef = useRef<BackupContext>({ primary: null, policy: 'wifi' });
  useEffect(() => {
    ctxRef.current = { primary, policy };
  }, [primary, policy]);

  const refreshConnected = useCallback(async (): Promise<void> => {
    const entries = await Promise.all(
      CLOUD_PROVIDER_IDS.map(async (id) => [id, await isConnected(id)] as const),
    );
    setConnected(Object.fromEntries(entries) as ConnectedMap);
  }, []);

  const refreshPending = useCallback(async (): Promise<void> => {
    setPending(await readPendingCount());
  }, []);

  const kick = useCallback(async (): Promise<void> => {
    const outcome = await runBackup(ctxRef.current);
    setLastSkip(outcome.skipped);
    await refreshPending();
  }, [refreshPending]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [savedPrimary, savedPolicy] = await Promise.all([
        AsyncStorage.getItem(PRIMARY_KEY).catch(() => null),
        AsyncStorage.getItem(POLICY_KEY).catch(() => null),
      ]);
      if (!active) return;
      if (savedPrimary && (CLOUD_PROVIDER_IDS as string[]).includes(savedPrimary)) {
        setPrimaryState(savedPrimary as CloudProviderId);
      }
      if (savedPolicy === 'any' || savedPolicy === 'wifi') setPolicyState(savedPolicy);
      await refreshConnected();
      await refreshPending();
      setLoading(false);
      void kick();
    })();
    return () => {
      active = false;
    };
  }, [refreshConnected, refreshPending, kick]);

  // Foreground and network changes are the moments a stuck upload can proceed.
  useEffect(() => {
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') void kick();
    });
    const net = Network.addNetworkStateListener(() => void kick());
    return () => {
      app.remove();
      net.remove();
    };
  }, [kick]);

  const setPrimary = useCallback(async (id: CloudProviderId | null): Promise<void> => {
    setPrimaryState(id);
    if (id) await AsyncStorage.setItem(PRIMARY_KEY, id).catch(() => undefined);
    else await AsyncStorage.removeItem(PRIMARY_KEY).catch(() => undefined);
    ctxRef.current = { ...ctxRef.current, primary: id };
    void kick();
  }, [kick]);

  const setPolicy = useCallback(async (next: BackupNetworkPolicy): Promise<void> => {
    setPolicyState(next);
    await AsyncStorage.setItem(POLICY_KEY, next).catch(() => undefined);
    ctxRef.current = { ...ctxRef.current, policy: next };
    void kick();
  }, [kick]);

  const connect = useCallback(async (id: CloudProviderId): Promise<boolean> => {
    const tokens = await providerFor(id).connect();
    if (!tokens) return false;
    await saveTokens(id, tokens);
    await refreshConnected();
    // First provider connected becomes primary, so a single tap is enough to
    // start backing up without a second trip to change the default.
    if (!ctxRef.current.primary) await setPrimary(id);
    else void kick();
    return true;
  }, [refreshConnected, setPrimary, kick]);

  const disconnect = useCallback(async (id: CloudProviderId): Promise<void> => {
    await clearTokens(id);
    await refreshConnected();
    if (ctxRef.current.primary === id) await setPrimary(null);
  }, [refreshConnected, setPrimary]);

  const value = useMemo<BackupValue>(
    () => ({
      loading,
      primary,
      policy,
      connected,
      pending,
      lastSkip,
      setPrimary,
      setPolicy,
      connect,
      disconnect,
      kick,
    }),
    [loading, primary, policy, connected, pending, lastSkip, setPrimary, setPolicy, connect, disconnect, kick],
  );

  return <BackupCtx.Provider value={value}>{children}</BackupCtx.Provider>;
}

export function useBackup(): BackupValue {
  const value = useContext(BackupCtx);
  if (!value) throw new Error('useBackup must be used inside BackupProvider');
  return value;
}
