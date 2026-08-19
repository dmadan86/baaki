/**
 * Which networks sync is allowed to use, and the switch for it.
 *
 * Three choices — Wi‑Fi only, mobile data only, or both — with Wi‑Fi the
 * default, because the safe assumption is that somebody would rather their
 * ledger wait for Wi‑Fi than spend a metered megabyte they did not choose to.
 *
 * This is a device-local preference (ADR-005 keeps the queue on the phone), so
 * it lives in AsyncStorage like theme and motion, not on the server. Two
 * readers need it: the settings screen, through the React hook, and the sync
 * engine — a plain singleton, no React — which reads it straight from disk each
 * flush via `loadSyncNetworkPreference`.
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

const KEY = 'baaki.sync_network';

export enum SyncNetworkPreference {
  /** Sync only on Wi‑Fi — never spend mobile data unasked. */
  Wifi = 'wifi',
  /** Sync only on mobile data, never Wi‑Fi. The deliberate, unusual choice. */
  Cellular = 'cellular',
  /** Sync on whatever connection is up. The default. */
  Both = 'both',
}

// Sync on any connection by default. A ledger people share is expected to be
// live wherever the phone is, and the payloads are tiny; Wi‑Fi-only used to be
// the default and made every cellular-only phone sit permanently on the
// "waiting for Wi‑Fi" glyph, which read as the app being offline or broken.
// Anyone who wants to hold data for Wi‑Fi can still choose it in settings.
const DEFAULT = SyncNetworkPreference.Both;

function parse(raw: string | null): SyncNetworkPreference {
  return raw === 'wifi' || raw === 'cellular' || raw === 'both'
    ? (raw as SyncNetworkPreference)
    : DEFAULT;
}

/**
 * Read the stored preference from disk. The engine calls this on every flush;
 * an AsyncStorage read is cheap next to a network round trip, and reading fresh
 * each time means a change on the settings screen takes effect on the very next
 * flush with no cache to keep in step.
 */
export async function loadSyncNetworkPreference(): Promise<SyncNetworkPreference> {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  return parse(raw);
}

interface SyncNetworkValue {
  preference: SyncNetworkPreference;
  /** True while the stored preference is still being read. */
  loading: boolean;
  setPreference: (value: SyncNetworkPreference) => Promise<void>;
}

const SyncNetworkContext = createContext<SyncNetworkValue | null>(null);

export function SyncNetworkProvider({ children }: { children: ReactNode }) {
  const [preference, setStored] = useState<SyncNetworkPreference>(DEFAULT);
  const [loading, setLoading] = useState(true);

  // Writes are serialized on this chain so they persist in request order, a
  // revision marks the newest request, and the last value known to be on disk is
  // the safe rollback target — together these stop an older, slower write from
  // overwriting a newer one on disk or on screen.
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const revisionRef = useRef(0);
  const committedRef = useRef<SyncNetworkPreference>(DEFAULT);

  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = await loadSyncNetworkPreference();
      if (!active) return;
      committedRef.current = saved;
      setStored(saved);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback(async (value: SyncNetworkPreference) => {
    const revision = ++revisionRef.current;
    setStored(value);
    const run = chainRef.current.then(async () => {
      try {
        // Wi‑Fi is the default, so storing it is the same as storing nothing —
        // and clearing the key keeps a fresh install and a reset-to-default
        // identical.
        if (value === DEFAULT) await AsyncStorage.removeItem(KEY);
        else await AsyncStorage.setItem(KEY, value);
        committedRef.current = value;
      } catch {
        // The engine reads from disk, so a switch that did not persist must not
        // keep claiming it did — but only roll back when nothing newer has been
        // requested since, or a stale failure would clobber a newer choice.
        if (revision === revisionRef.current) setStored(committedRef.current);
      }
    });
    chainRef.current = run;
    return run;
  }, []);

  const value = useMemo<SyncNetworkValue>(
    () => ({ preference, loading, setPreference }),
    [preference, loading, setPreference],
  );

  return <SyncNetworkContext.Provider value={value}>{children}</SyncNetworkContext.Provider>;
}

export function useSyncNetwork(): SyncNetworkValue {
  const value = useContext(SyncNetworkContext);
  if (!value) throw new Error('useSyncNetwork must be used inside SyncNetworkProvider');
  return value;
}
