/**
 * Favourite groups — a star you can put on a group, kept on this device.
 *
 * A favourite is a personal shortcut, not shared ledger state: which groups
 * *you* reach for says nothing the other members need to sync, and keeping it
 * local means no migration and no round-trip to set it. The one place it earns
 * its keep is the "start from an existing group" picker, where favourites float
 * to the top so the group you clone every month is the first one you see.
 *
 * A module-level store rather than a provider: the star is read from the group
 * settings screen and the clone picker at once, and both should agree the
 * instant one of them toggles, without threading a context through the tree.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'favorites.groups';

let ids = new Set<string>();
let loaded = false;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const persist = (): void => {
  // Fire-and-forget: the in-memory set is the truth for this run, disk is only
  // so the star survives a restart. A failed write loses a preference, never data.
  void AsyncStorage.setItem(KEY, JSON.stringify([...ids])).catch(() => undefined);
};

const load = async (): Promise<void> => {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        ids = new Set(parsed.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    // A corrupt value is no favourites, not a crash.
    ids = new Set();
  }
  emit();
};

export interface Favorites {
  readonly favorites: ReadonlySet<string>;
  readonly ready: boolean;
  isFavorite(groupId: string): boolean;
  toggle(groupId: string): void;
}

export function useFavorites(): Favorites {
  const [, force] = useState(0);
  const [ready, setReady] = useState(loaded);

  useEffect(() => {
    const listener = (): void => {
      setReady(true);
      force((n) => n + 1);
    };
    listeners.add(listener);
    void load().then(() => setReady(true));
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const toggle = useCallback((groupId: string): void => {
    if (!groupId) return;
    if (ids.has(groupId)) ids.delete(groupId);
    else ids.add(groupId);
    persist();
    emit();
  }, []);

  const isFavorite = useCallback((groupId: string): boolean => ids.has(groupId), []);

  return { favorites: ids, ready, isFavorite, toggle };
}
