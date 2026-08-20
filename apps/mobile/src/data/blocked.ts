/**
 * People you have blocked, and the single question every screen asks about them.
 *
 * Blocking here is a display-level act, not a server-enforced one: it hides a
 * person's identity on this device by rendering them as the app's existing
 * anonymous ghost (the "Someone" name and the dashed ghost avatar) wherever they
 * would otherwise appear. It never touches a balance, a share or a settlement —
 * you can still owe or be owed by somebody you have blocked, you just stop seeing
 * who they are. Because it is a per-device privacy preference and nothing the
 * other person should learn about, it lives in AsyncStorage, keyed on the blocked
 * person's profile id (their one identity across every group) — no table, no
 * migration, no sync. Server-enforced blocking (refusing shared groups, hiding
 * you from them) is a deliberate follow-up, called out in the PR.
 *
 * The set is a module-level store with subscribers rather than per-hook state:
 * many screens render a person at once, and blocking on one must ghost them on
 * all of them immediately, without a reload. A snapshot of the name and avatar is
 * kept alongside the id so the "Blocked users" list can still name each person —
 * the one screen that intentionally shows their real identity, so you know who
 * you are unblocking.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** The AsyncStorage key. `v1` leaves room to change the shape without a clash. */
const STORAGE_KEY = 'blockedUsers:v1';

export interface BlockedUser {
  /** The blocked person's profile (user) id — their identity across all groups. */
  id: string;
  /** Their name at the moment they were blocked, so the unblock list can name
   *  them even though every other surface now shows them as a ghost. */
  name: string;
  /** Avatar storage path or URL snapshot, or null — resolved like any avatar. */
  avatarUrl: string | null;
}

/** Parse the stored blob defensively — a corrupt value is an empty list, not a crash. */
export function parseBlocked(raw: string | null): BlockedUser[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (item): item is { id: string; name?: unknown; avatarUrl?: unknown } =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { id?: unknown }).id === 'string',
      )
      .map((item) => ({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : '',
        avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : null,
      }));
  } catch {
    return [];
  }
}

/** Next list after blocking `user`: newest first, one entry per id (a re-block
 *  refreshes the snapshot rather than duplicating). Pure, so it is unit-tested. */
export function upsertBlocked(list: readonly BlockedUser[], user: BlockedUser): BlockedUser[] {
  return [user, ...list.filter((entry) => entry.id !== user.id)];
}

/** Next list after unblocking `id`. Pure. */
export function removeBlocked(list: readonly BlockedUser[], id: string): BlockedUser[] {
  return list.filter((entry) => entry.id !== id);
}

// --- module store -----------------------------------------------------------

let blocked: readonly BlockedUser[] = [];
let ready = false;
let hydration: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

// Set once a block/unblock has run. If one lands while the initial read is
// still pending, the read's older snapshot must not overwrite the live list.
let mutated = false;

/** Load once, lazily, on first subscribe. Failures leave an empty list, ready. */
function hydrate(): Promise<void> {
  if (hydration) return hydration;
  hydration = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (!mutated) blocked = parseBlocked(raw);
    })
    .catch(() => {
      if (!mutated) blocked = [];
    })
    .finally(() => {
      ready = true;
      emit();
    });
  return hydration;
}

function persist(next: readonly BlockedUser[]): void {
  mutated = true;
  blocked = next;
  emit();
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  void hydrate();
  return () => {
    listeners.delete(callback);
  };
}

function snapshotList(): readonly BlockedUser[] {
  return blocked;
}

function snapshotReady(): boolean {
  return ready;
}

export interface UseBlockedUsers {
  /** The blocked people, newest first, with their name/avatar snapshots. */
  blocked: readonly BlockedUser[];
  /** Just the ids — the set every render site checks a person against. */
  blockedIds: ReadonlySet<string>;
  /** False until the stored list has loaded, so nothing flashes real-then-ghost. */
  ready: boolean;
  isBlocked: (profileId: string | null | undefined) => boolean;
  block: (user: BlockedUser) => void;
  unblock: (id: string) => void;
}

/**
 * The single source of truth for who is blocked. Every screen that renders a
 * person reads `blockedIds` from here and asks the same question, so a block
 * takes effect everywhere at once.
 */
export function useBlockedUsers(): UseBlockedUsers {
  const list = useSyncExternalStore(subscribe, snapshotList, snapshotList);
  const isReady = useSyncExternalStore(subscribe, snapshotReady, snapshotReady);

  const blockedIds = useMemo(() => new Set(list.map((entry) => entry.id)), [list]);

  const isBlocked = useCallback(
    (profileId: string | null | undefined): boolean =>
      Boolean(profileId && blockedIds.has(profileId)),
    [blockedIds],
  );

  const block = useCallback((user: BlockedUser) => {
    persist(upsertBlocked(blocked, user));
  }, []);

  const unblock = useCallback((id: string) => {
    persist(removeBlocked(blocked, id));
  }, []);

  return { blocked: list, blockedIds, ready: isReady, isBlocked, block, unblock };
}
