/**
 * The offline half of adding a receipt (ADR-005 for images).
 *
 * Attaching a receipt online is upload → RPC → done. Offline, both steps need
 * the network, so instead of failing this parks the capture: the bytes are
 * written to a durable file, a queue entry is recorded, and the gallery shows
 * the image straight away from that local file. When the device is back online
 * a flush walks the queue — uploading each capture to R2 and recording the
 * attachment row exactly as the online path would, then seeding the view cache
 * so the receipt keeps showing with no network and dropping the queue entry.
 *
 * The queue index lives in AsyncStorage (small, structured); the image bytes
 * live under the OS *document* directory — not the cache — because a pending
 * upload is unsent data the OS must not reclaim, unlike the view cache which it
 * may. A flushed capture's bytes move into the view cache and out of here.
 *
 * The entry's `attachmentId` is the eventual row id, chosen up front, so the
 * optimistic gallery item and the real row that arrives after the flush share
 * one identity — the gallery de-dupes on it, and a retry never doubles a row.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode } from 'base64-arraybuffer';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';

import { backend } from '@/lib/backend';
import { putImage } from '@/lib/storage';
import { cacheImageBytes } from '@/lib/storage/imageCache';
import { endTransfer, setTransferProgress, startTransfer } from '@/lib/transferProgress';

/** The transfer id the receipt-upload flush reports under (one bar for the batch). */
const FLUSH_TRANSFER_ID = 'receipt-upload';

/** AsyncStorage key for the queue index. Versioned so a shape change can migrate. */
const QUEUE_KEY = 'receipt-upload-queue.v1';

/** Durable subdirectory (under the document dir) holding unsent capture bytes. */
const PENDING_DIR = 'pending-receipts';

/** A capture waiting to be uploaded. */
export interface PendingReceipt {
  /** The eventual attachment row id — the optimistic item and the real row share it. */
  attachmentId: string;
  expenseId: string;
  groupId: string;
  visibility: 'group' | 'parties';
  /** The R2 object key, chosen up front so upload and RPC agree. */
  storagePath: string;
  contentType: string;
  /** Basename of the bytes file under {@link PENDING_DIR} (dir resolved at read time). */
  fileName: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

/** The extension for a stored image, matching the online attach path. */
function extensionFor(contentType: string): string {
  return contentType === 'image/webp' ? 'webp' : 'jpg';
}

async function readQueue(): Promise<PendingReceipt[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PendingReceipt[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: readonly PendingReceipt[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

/** The durable file holding one pending capture's bytes. */
function pendingFile(entry: Pick<PendingReceipt, 'fileName'>): File {
  return new File(Paths.document, PENDING_DIR, entry.fileName);
}

/** The `file://` a gallery renders for a still-unsent capture. */
export function pendingReceiptUri(entry: PendingReceipt): string {
  return pendingFile(entry).uri;
}

/** Is there a usable network right now? Fail-open, matching the sync engine. */
export async function isOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.isInternetReachable ?? state.isConnected ?? true;
  } catch {
    return true;
  }
}

/** Every pending capture, or those for one expense, oldest first. */
export async function listPendingReceipts(expenseId?: string): Promise<PendingReceipt[]> {
  const queue = await readQueue();
  return expenseId ? queue.filter((entry) => entry.expenseId === expenseId) : queue;
}

/** Sign-out/privacy cleanup: drop the queue index and every pending capture byte file. */
export async function clearReceiptQueue(): Promise<void> {
  const queue = await readQueue();
  for (const entry of queue) {
    try {
      const file = pendingFile(entry);
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup; keep deleting the rest.
    }
  }

  try {
    const dir = new Directory(Paths.document, PENDING_DIR);
    if (dir.exists) dir.delete();
  } catch {
    // Some file-system implementations cannot delete non-empty dirs; queued files
    // above were already attempted, and the index removal below is the source of truth.
  }

  await AsyncStorage.removeItem(QUEUE_KEY);
}

/**
 * Park a picked image for later upload: write its bytes to a durable file and
 * record the queue entry. Returns the entry so the caller can show it at once.
 */
export async function enqueueReceipt(input: {
  expenseId: string;
  groupId: string;
  visibility: 'group' | 'parties';
  base64: string;
  contentType: string;
}): Promise<PendingReceipt> {
  const attachmentId = randomUUID();
  const ext = extensionFor(input.contentType);
  const entry: PendingReceipt = {
    attachmentId,
    expenseId: input.expenseId,
    groupId: input.groupId,
    visibility: input.visibility,
    storagePath: `${input.expenseId}/${randomUUID()}.${ext}`,
    contentType: input.contentType,
    fileName: `${attachmentId}.${ext}`,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  };

  const dir = new Directory(Paths.document, PENDING_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  pendingFile(entry).write(new Uint8Array(decode(input.base64)));

  const queue = await readQueue();
  await writeQueue([...queue, entry]);
  return entry;
}

/** Drop a pending capture the user chose not to keep, deleting its bytes too. */
export async function discardPendingReceipt(attachmentId: string): Promise<void> {
  const queue = await readQueue();
  const entry = queue.find((item) => item.attachmentId === attachmentId);
  if (entry) {
    try {
      const file = pendingFile(entry);
      if (file.exists) file.delete();
    } catch {
      // Already gone — nothing to clean up.
    }
  }
  await writeQueue(queue.filter((item) => item.attachmentId !== attachmentId));
}

/** A server error that will never succeed on retry — the capture must not loop forever. */
function isPermanent(message: string): boolean {
  return (
    message.includes('ATTACHMENT_CAP') ||
    message.includes('NOT_A_PARTY') ||
    message.includes('not authorized') ||
    message.includes('permission')
  );
}

/** The outcome of a flush, for the caller to refresh the right queries. */
export interface FlushResult {
  /** Expense ids that gained at least one uploaded attachment. */
  uploadedExpenseIds: string[];
  /** True when a capture was refused for good (cap reached / not a party). */
  hadPermanentFailure: boolean;
}

/**
 * Upload every pending capture that can be sent now. Best-effort and safe to
 * call often (screen mount, reconnect): it no-ops when the queue is empty or the
 * device is offline, and each entry is handled in isolation so one stuck capture
 * never blocks the rest.
 *
 * On success the bytes move into the view cache (so the receipt stays offline-
 * readable) and the entry and its file are dropped. A transient failure leaves
 * the entry to retry; a permanent one (cap, not a party) is dropped with its
 * reason surfaced, so it does not loop forever.
 */
let inFlight: Promise<FlushResult> | null = null;

export function flushReceiptQueue(): Promise<FlushResult> {
  // Single-flight: two concurrent flushes would upload the same entries twice,
  // share one FLUSH_TRANSFER_ID (the first endTransfer clearing the bar mid-way
  // through the second), and race their write-backs. Callers reconnect and mount
  // independently, so overlap is real — coalesce them onto one run.
  if (inFlight) return inFlight;
  inFlight = runFlush().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runFlush(): Promise<FlushResult> {
  const queue = await readQueue();
  if (queue.length === 0) return { uploadedExpenseIds: [], hadPermanentFailure: false };
  if (!(await isOnline())) return { uploadedExpenseIds: [], hadPermanentFailure: false };

  const remaining: PendingReceipt[] = [];
  const uploaded = new Set<string>();
  let hadPermanentFailure = false;

  // Drive the in-app progress bar for the batch: one step per capture, marked
  // done as each is handled (uploaded, dropped, or failed). The bar is behind a
  // feature flag, but reporting is cheap and always on — the flag only decides
  // whether anything is drawn.
  startTransfer(FLUSH_TRANSFER_ID, queue.length);
  let handled = 0;

  // The loop sits in try/finally so a throw from pendingFile/file.exists (which
  // run outside the per-entry try) still ends the transfer — otherwise the bar
  // sticks on screen at done < total until some later flush completes.
  try {
    for (const entry of queue) {
      const file = pendingFile(entry);
      if (!file.exists) {
        // The bytes are gone (a wipe, a failed write) — nothing to send; drop it.
        handled += 1;
        setTransferProgress(FLUSH_TRANSFER_ID, handled);
        continue;
      }

      try {
        const base64 = await file.base64();
        await putImage({
          bucket: 'expense-attachments',
          path: entry.storagePath,
          base64,
          contentType: entry.contentType,
          groupId: entry.groupId,
          subjectId: entry.expenseId,
        });
        const { error } = await backend.rpc('baaki_attach_expense_attachment', {
          p_expense_id: entry.expenseId,
          p_storage_path: entry.storagePath,
          p_visibility: entry.visibility,
          p_attachment_id: entry.attachmentId,
        });
        if (error) throw new Error(error.message);

        // Uploaded and recorded. Keep it viewable offline by moving the bytes into
        // the view cache, then delete the pending file.
        cacheImageBytes('expense-attachments', entry.storagePath, new Uint8Array(decode(base64)));
        try {
          file.delete();
        } catch {
          // Best-effort; a lingering file is reclaimed with the app's document dir.
        }
        uploaded.add(entry.expenseId);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (isPermanent(message)) {
          hadPermanentFailure = true;
          try {
            file.delete();
          } catch {
            /* ignore */
          }
          continue; // Drop — a retry would only fail the same way.
        }
        // Transient (offline mid-flush, a 5xx): keep it to try again later.
        remaining.push({ ...entry, attempts: entry.attempts + 1, lastError: message });
      } finally {
        handled += 1;
        setTransferProgress(FLUSH_TRANSFER_ID, handled);
      }
    }
  } finally {
    endTransfer(FLUSH_TRANSFER_ID);
  }

  // Re-read before writing back: enqueueReceipt may have appended during the
  // uploads above, and writing `remaining` alone would silently drop it (its
  // bytes then orphaned under PENDING_DIR). Keep only the entries this run
  // handled out of the write, and carry any that arrived meanwhile.
  const handledIds = new Set(queue.map((entry) => entry.attachmentId));
  const current = await readQueue();
  const arrivedDuringFlush = current.filter((entry) => !handledIds.has(entry.attachmentId));
  await writeQueue([...remaining, ...arrivedDuringFlush]);
  return { uploadedExpenseIds: [...uploaded], hadPermanentFailure };
}
