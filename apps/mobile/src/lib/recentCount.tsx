/**
 * How many recent expenses the watch shows.
 *
 * A per-device preference (not ledger data), so it lives in AsyncStorage and is
 * relayed to the paired watch rather than synced through Supabase. The offered
 * sizes and the default come from `@waves/core` so the phone, the relay codec
 * and the watch all agree on what's allowed. Modelled on `shortcut.tsx`.
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

import { coerceRecentCount, DEFAULT_RECENT_COUNT, type RecentCount } from '@waves/core';

const KEY = 'recent.count';

interface RecentCountValue {
  /** The chosen size; the default until the stored value loads. */
  count: RecentCount;
  loading: boolean;
  setCount: (next: RecentCount) => Promise<void>;
}

const RecentCountContext = createContext<RecentCountValue | null>(null);

export function RecentCountProvider({ children }: { children: ReactNode }) {
  const [count, setCountState] = useState<RecentCount>(DEFAULT_RECENT_COUNT);
  const [loading, setLoading] = useState(true);

  // A change made during the (brief) storage read must not be reversed by the
  // hydrated value landing afterwards (same guard as shortcut.tsx).
  const dirty = useRef(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = await AsyncStorage.getItem(KEY).catch(() => null);
      if (!active) return;
      if (!dirty.current && saved !== null) setCountState(coerceRecentCount(saved));
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  const setCount = useCallback(async (next: RecentCount) => {
    dirty.current = true;
    setCountState(next);
    await AsyncStorage.setItem(KEY, String(next)).catch(() => undefined);
  }, []);

  const value = useMemo<RecentCountValue>(
    () => ({ count, loading, setCount }),
    [count, loading, setCount],
  );

  return <RecentCountContext.Provider value={value}>{children}</RecentCountContext.Provider>;
}

export function useRecentCount(): RecentCountValue {
  const value = useContext(RecentCountContext);
  if (!value) throw new Error('useRecentCount must be used inside RecentCountProvider');
  return value;
}
