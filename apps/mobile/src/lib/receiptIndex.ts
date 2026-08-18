/**
 * The ledger of which saved receipts still need backing up, and where the ones
 * already backed up ended up.
 *
 * The files in the vault ({@link receiptStore}) are the receipts; this is the
 * bookkeeping around them. It is a separate store because "is this file on the
 * user's cloud yet?" is not a property of the file — it depends on which
 * provider is primary, whether the network was allowed, and whether the last
 * attempt failed. Keeping it here means the backup queue has one place to ask
 * "what is still pending?" without stat-ing the whole folder.
 *
 * One AsyncStorage key holds the whole map, read and written as a blob. The
 * volume is tiny (one small record per receipt) and every mutation is a
 * read‑modify‑write, which is safe because the only writer is the backup queue
 * plus the capture screen, never two at once.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CloudProviderId } from './cloud/types';

const KEY = 'baaki.receipt_backup_index';

export type BackupState = 'pending' | 'synced' | 'error';

export interface ReceiptIndexEntry {
  readonly captureId: string;
  readonly imageUri: string;
  /** The JSON sidecar's URI, or null when the receipt has only an image. */
  readonly jsonUri: string | null;
  readonly state: BackupState;
  /** Which provider it was uploaded to, once synced. */
  readonly provider: CloudProviderId | null;
  /** The provider's id for the uploaded image, for de-dup and later deletion. */
  readonly remoteId: string | null;
  /** Failed attempts since the last success — drives the backoff. */
  readonly attempts: number;
  /** Last error message, for the settings screen to show. */
  readonly error: string | null;
  /** ISO instant of the last change. */
  readonly updatedAt: string;
}

type IndexMap = Record<string, ReceiptIndexEntry>;

async function readMap(): Promise<IndexMap> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as IndexMap) : {};
  } catch {
    return {};
  }
}

async function writeMap(map: IndexMap): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(map)).catch(() => undefined);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs read-modify-write mutations one at a time. The capture screen and the
 * backup queue both mutate this map; without serialising, a write that started
 * from an older snapshot can clobber an update that landed in between.
 */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export async function allEntries(): Promise<ReceiptIndexEntry[]> {
  return Object.values(await readMap());
}

export async function pendingEntries(): Promise<ReceiptIndexEntry[]> {
  return (await allEntries()).filter((entry) => entry.state !== 'synced');
}

/**
 * Record a freshly saved receipt as needing backup. Called the moment the
 * capture screen writes the files, before any network is involved, so a receipt
 * caught offline is remembered and uploaded later rather than lost.
 */
export async function markPending(
  captureId: string,
  files: { imageUri: string; jsonUri: string | null },
  now: string,
): Promise<void> {
  await serial(async () => {
    const map = await readMap();
    // A re-scan overwrites the same capture id; keep any remote id/provider
    // from an already-synced upload so the queue can replace the remote copy
    // rather than orphan it in the user's cloud.
    const existing = map[captureId];
    map[captureId] = {
      captureId,
      imageUri: files.imageUri,
      jsonUri: files.jsonUri,
      state: 'pending',
      provider: existing?.provider ?? null,
      remoteId: existing?.remoteId ?? null,
      attempts: 0,
      error: null,
      updatedAt: now,
    };
    await writeMap(map);
  });
}

export async function markSynced(
  captureId: string,
  result: { provider: CloudProviderId; remoteId: string },
  now: string,
): Promise<void> {
  await serial(async () => {
    const map = await readMap();
    const entry = map[captureId];
    if (!entry) return;
    map[captureId] = {
      ...entry,
      state: 'synced',
      provider: result.provider,
      remoteId: result.remoteId,
      attempts: 0,
      error: null,
      updatedAt: now,
    };
    await writeMap(map);
  });
}

export async function markError(captureId: string, message: string, now: string): Promise<void> {
  await serial(async () => {
    const map = await readMap();
    const entry = map[captureId];
    if (!entry) return;
    map[captureId] = {
      ...entry,
      state: 'error',
      attempts: entry.attempts + 1,
      error: message,
      updatedAt: now,
    };
    await writeMap(map);
  });
}

/**
 * Turn every errored receipt back into a pending one, clearing its attempt
 * count and last message. The photos themselves are untouched in the vault —
 * this only forgives the backoff so a receipt that gave up (or hit the attempt
 * ceiling) is tried again after the person has fixed whatever blocked it.
 */
export async function resetErrored(now: string): Promise<void> {
  await serial(async () => {
    const map = await readMap();
    for (const id of Object.keys(map)) {
      const entry = map[id];
      if (entry.state !== 'error') continue;
      map[id] = { ...entry, state: 'pending', attempts: 0, error: null, updatedAt: now };
    }
    await writeMap(map);
  });
}

export async function removeEntry(captureId: string): Promise<void> {
  await serial(async () => {
    const map = await readMap();
    if (!(captureId in map)) return;
    delete map[captureId];
    await writeMap(map);
  });
}

/** How many receipts are still waiting to reach the cloud — for the badge/label. */
export async function pendingCount(): Promise<number> {
  return (await pendingEntries()).length;
}
