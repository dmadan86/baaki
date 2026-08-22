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
 * The store is a plain, framework-free object so it can be tested without React;
 * `useFavorites` is only the thin subscription that re-renders a screen.
 */
import { useEffect, useState } from 'react';
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

/** Read the stored stars once, on first use. Idempotent — later calls are no-ops. */
export async function loadFavorites(): Promise<void> {
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
}

export function isFavorite(groupId: string): boolean {
  return ids.has(groupId);
}

export function toggleFavorite(groupId: string): void {
  if (!groupId) return;
  if (ids.has(groupId)) ids.delete(groupId);
  else ids.add(groupId);
  persist();
  emit();
}

/** Subscribe to any change; returns an unsubscribe. */
export function subscribeFavorites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget everything, as if the app had never run. */
export function __resetFavoritesForTest(): void {
  ids = new Set();
  loaded = false;
  listeners.clear();
}

export interface Favorites {
  readonly ready: boolean;
  isFavorite(groupId: string): boolean;
  toggle(groupId: string): void;
}

export function useFavorites(): Favorites {
  const [, force] = useState(0);
  const [ready, setReady] = useState(loaded);

  useEffect(() => {
    const unsubscribe = subscribeFavorites(() => {
      setReady(true);
      force((n) => n + 1);
    });
    void loadFavorites().then(() => setReady(true));
    return unsubscribe;
  }, []);

  return { ready, isFavorite, toggle: toggleFavorite };
}
