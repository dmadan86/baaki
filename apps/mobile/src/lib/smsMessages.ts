/**
 * The device-only message store, as something a screen can render.
 *
 * The ledger reaches screens through the sync mirror, which is already in
 * memory and already published — `useCaptures` is a `useMemo` over it. Bank
 * messages are not in that mirror and never will be: they live in their own
 * SQLite file precisely so that nothing which syncs can see them
 * (`smsMessageStore.ts`). So they need a small amount of what the mirror gives
 * for free, and this is it.
 *
 * Module state, not React state, for the same reason the automatic reader uses
 * module state: the list screen, the detail screen and the entry row in Review
 * can all be mounted at once, and every one of them has to see the same rows
 * and the same count. Three components each holding their own copy would read
 * the database three times and then disagree about what is in it.
 *
 * A scan calls {@link reloadMessages} when it finishes, and everything mounted
 * re-renders with what it found. Nothing polls.
 */

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';

import { loadMessages } from './smsMessageStore';
import type { StoredSms } from './smsMessageTypes';

interface Snapshot {
  /** Whose rows these are. Empty before the first load, or when signed out. */
  readonly ownerId: string;
  readonly rows: readonly StoredSms[];
  /** True until the first load for this account has come back. */
  readonly loading: boolean;
}

let snapshot: Snapshot = { ownerId: '', rows: [], loading: true };
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** The load in flight, so two mounts in one tick read the file once. */
let inFlight: Promise<void> | null = null;

/**
 * Read the store and publish it.
 *
 * Called on mount, and by anything that changed the rows: a scan, a placement,
 * a dismissal. Concurrent callers share one read — a screen that ticks twelve
 * rows and places them fires one reload, not twelve.
 */
export function reloadMessages(ownerId: string): Promise<void> {
  if (!ownerId) {
    publish({ ownerId: '', rows: [], loading: false });
    return Promise.resolve();
  }
  if (inFlight) return inFlight;
  inFlight = loadMessages(ownerId)
    .then((rows) => {
      publish({ ownerId, rows, loading: false });
    })
    .catch(() => {
      // Nothing reported: `smsMessageStore.ts` says why. An empty list with
      // `loading: false` is what the screen shows, and its empty state offers
      // the scan that would fill it.
      publish({ ownerId, rows: [], loading: false });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export interface SmsMessagesState {
  readonly rows: readonly StoredSms[];
  readonly loading: boolean;
  /** Read the store again — after a scan, or after placing rows. */
  readonly reload: () => Promise<void>;
}

/**
 * Every bank message this phone has read, for the account that is signed in.
 *
 * `enabled` is the caller's gate — pass the same verdict the Bank messages
 * screen asks itself. False answers as an empty, settled store and touches no
 * file.
 *
 * Safe to mount more than once. The whole set rather than a page: ninety days
 * of one person's messages is hundreds of rows, not thousands, and the screen
 * searches, filters and counts across all of them at once. Paging would mean a
 * search that only searched what had been scrolled to.
 */
export function useSmsMessages(enabled = true): SmsMessagesState {
  const { session } = useAuth();
  // A phone with no reader has no messages, and opening a database to find that
  // out on every launch is work for nothing. Review mounts this hook to draw one
  // row, and on iOS — where no reading API exists at any tier — that row is not
  // drawn at all.
  const ownerId = enabled ? (session?.user?.id ?? '') : '';
  const [local, setLocal] = useState<Snapshot>(snapshot);

  useEffect(() => {
    const listener = (): void => setLocal(snapshot);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // On mount, and whenever the account changes. The guard matters: without it,
  // a re-render would re-read the file, and this hook is mounted on a screen
  // that re-renders on every keystroke in its search box.
  useEffect(() => {
    if (snapshot.ownerId === ownerId && !snapshot.loading) return;
    void reloadMessages(ownerId);
  }, [ownerId]);

  const reload = useCallback(() => reloadMessages(ownerId), [ownerId]);

  // Rows from a previous account are never handed out, even for the frame
  // between a sign-in and the read that follows it.
  return {
    rows: local.ownerId === ownerId ? local.rows : [],
    loading: local.loading || local.ownerId !== ownerId,
    reload,
  };
}
