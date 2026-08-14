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
  readonly jsonUri: string;
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
  files: { imageUri: string; jsonUri: string },
  now: string,
): Promise<void> {
  const map = await readMap();
  map[captureId] = {
    captureId,
    imageUri: files.imageUri,
    jsonUri: files.jsonUri,
    state: 'pending',
    provider: null,
    remoteId: null,
    attempts: 0,
    error: null,
    updatedAt: now,
  };
  await writeMap(map);
}

export async function markSynced(
  captureId: string,
  result: { provider: CloudProviderId; remoteId: string },
  now: string,
): Promise<void> {
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
}

export async function markError(captureId: string, message: string, now: string): Promise<void> {
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
}

export async function removeEntry(captureId: string): Promise<void> {
  const map = await readMap();
  if (!(captureId in map)) return;
  delete map[captureId];
  await writeMap(map);
}

/** How many receipts are still waiting to reach the cloud — for the badge/label. */
export async function pendingCount(): Promise<number> {
  return (await pendingEntries()).length;
}
