/**
 * Every receipt an expense gains goes through here (ADR-005 for images).
 *
 * Adding a receipt used to be two different things depending on the weather:
 * online it was upload → RPC → done, driven by a mutation living on the expense
 * screen; offline the capture was parked on the device and sent on reconnect.
 * The online half had three problems the person could feel. Nothing appeared
 * while the bytes were in the air, so there was no way to tell a slow upload
 * from one that had quietly failed. Walking away from the screen took the
 * mutation's callbacks with it. And an app killed mid-upload lost the photograph
 * outright — it only ever existed in memory and in the picker's cache.
 *
 * So there is one path now, the durable one: a picked image is written to a file
 * and recorded in a queue *before* anything is sent, and the queue is what
 * uploads it. The gallery shows the capture from its local file the instant it
 * is parked, wearing the state it is actually in — waiting, sending, or not
 * sent — and a flush that finishes while the person is three screens away still
 * lands. Nothing about that is tied to a component being mounted.
 *
 * The queue index lives in AsyncStorage (small, structured); the image bytes
 * live under the OS *document* directory — not the cache — because a pending
 * upload is unsent data the OS must not reclaim, unlike the view cache which it
 * may. A flushed capture's bytes move into the view cache and out of here.
 *
 * The entry's `attachmentId` is the eventual row id, chosen up front, so the
 * optimistic gallery item and the real row that arrives after the flush share
 * one identity — the gallery de-dupes on it, and a retry never doubles a row.
 *
 * Views subscribe rather than poll: the queue publishes a snapshot on every
 * change (parked, sending, sent, failed) through `usePendingReceipts`, the same
 * `useSyncExternalStore` shape `transferProgress` uses, because the work that
 * changes it happens in plain library code with no React around it.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode } from 'base64-arraybuffer';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';

import { backend } from '@/lib/backend';
import { putImage, removeRestrictedImage } from '@/lib/storage';
import { cacheImageBytes } from '@/lib/storage/imageCache';
import { endTransfer, setTransferProgress, startTransfer } from '@/lib/transferProgress';

/** The transfer id the receipt-upload flush reports under (one bar for the batch). */
const FLUSH_TRANSFER_ID = 'receipt-upload';

/** AsyncStorage key for the queue index. Versioned so a shape change can migrate. */
const QUEUE_KEY = 'receipt-upload-queue.v1';

/** Durable subdirectory (under the document dir) holding unsent capture bytes. */
const PENDING_DIR = 'pending-receipts';

/**
 * How long a failed capture waits before a background flush tries it again,
 * indexed by how many attempts it has already cost. A flush only runs on an
 * event — a screen mounting, the connection returning, the app coming forward —
 * so this is not guarding against a hot loop; it is stopping a capture that
 * fails for a durable reason (a server having a bad hour) from burning the
 * radio every time the person switches apps. The last value is the ceiling.
 * A person who taps "try again" bypasses all of it — see {@link retryPendingReceipts}.
 */
const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

function backoffFor(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[index] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0;
}

/** A capture waiting to be uploaded. This is the persisted shape. */
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
  /** The last failure's raw message. Kept for diagnosis; never shown to anybody. */
  lastError: string | null;
  /**
   * The server refused this capture for a reason a retry will not change (the
   * per-expense ceiling, not being a party). Background flushes skip it, so it
   * neither loops nor disappears — it sits in the gallery as a failed tile the
   * person can act on, which is the whole point: a capture that vanished with no
   * explanation was the old behaviour and it was indistinguishable from a bug.
   */
  permanent?: boolean;
  /** Earliest time a background flush may try again; see {@link RETRY_BACKOFF_MS}. */
  nextAttemptAt?: string | null;
}

/**
 * What a parked capture is doing right now, as far as anybody looking at the
 * gallery is concerned.
 *
 * `uploading` is deliberately *not* persisted: an app killed mid-upload comes
 * back as `queued`, because that is the truth — the bytes are on disk and
 * nothing is in the air until a flush picks them up again.
 */
export type PendingReceiptStatus = 'queued' | 'uploading' | 'failed';

/** A pending capture as a view renders it: the stored row plus its live state. */
export interface PendingReceiptView extends PendingReceipt {
  status: PendingReceiptStatus;
}

/** The extension for a stored image, matching the online attach path. */
function extensionFor(contentType: string): string {
  return contentType === 'image/webp' ? 'webp' : 'jpg';
}

// --- The published snapshot -------------------------------------------------
//
// One cached array of views, rebuilt whenever the stored queue or the set of
// in-flight uploads changes, so `useSyncExternalStore` sees a stable reference
// between changes and a fresh one across them.

const listeners = new Set<() => void>();
const uploading = new Set<string>();
let stored: readonly PendingReceipt[] = [];
let snapshot: readonly PendingReceiptView[] = [];
/** Whether the stored queue has been read off disk at least once this launch. */
let hydrated = false;

function statusOf(entry: PendingReceipt): PendingReceiptStatus {
  if (uploading.has(entry.attachmentId)) return 'uploading';
  return entry.lastError ? 'failed' : 'queued';
}

function republish(): void {
  snapshot = stored.map((entry) => ({ ...entry, status: statusOf(entry) }));
  for (const listener of listeners) listener();
}

/**
 * Whether two reads of the queue say the same thing. Every read parses fresh
 * objects out of JSON, so identity tells us nothing — and without this a flush
 * that found nothing to do would still notify every mounted gallery, on every
 * reconnect and every return to the foreground.
 */
function sameQueue(a: readonly PendingReceipt[], b: readonly PendingReceipt[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.attachmentId === other.attachmentId &&
      entry.attempts === other.attempts &&
      entry.lastError === other.lastError &&
      Boolean(entry.permanent) === Boolean(other.permanent) &&
      (entry.nextAttemptAt ?? null) === (other.nextAttemptAt ?? null)
    );
  });
}

function publish(next: readonly PendingReceipt[]): void {
  const unchanged = hydrated && sameQueue(stored, next);
  stored = next;
  hydrated = true;
  if (!unchanged) republish();
}

/** Mark one capture as in the air (or no longer), so its tile can say so. */
function markUploading(attachmentId: string, active: boolean): void {
  const was = uploading.has(attachmentId);
  if (active) uploading.add(attachmentId);
  else uploading.delete(attachmentId);
  if (was !== active) republish();
}

export function subscribePendingReceipts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPendingReceiptsSnapshot(): readonly PendingReceiptView[] {
  return snapshot;
}

/**
 * Every parked capture (optionally only one expense's), with its live status,
 * re-rendering as the queue moves. Reads off disk once per launch on first use,
 * so a screen opened straight after a cold start still sees what is waiting.
 */
export function usePendingReceipts(expenseId?: string): readonly PendingReceiptView[] {
  const all = useSyncExternalStore(
    subscribePendingReceipts,
    getPendingReceiptsSnapshot,
    getPendingReceiptsSnapshot,
  );
  useEffect(() => {
    // Module state, not a reactive value — this is a one-shot cold-start read,
    // and every later change arrives through the subscription above.
    if (!hydrated) void listPendingReceipts();
  }, []);
  return useMemo(
    () => (expenseId ? all.filter((entry) => entry.expenseId === expenseId) : all),
    [all, expenseId],
  );
}

// --- Storage ----------------------------------------------------------------

async function readQueue(): Promise<PendingReceipt[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const queue = Array.isArray(parsed) ? (parsed as PendingReceipt[]) : [];
    publish(queue);
    return queue;
  } catch {
    publish([]);
    return [];
  }
}

async function writeQueue(queue: readonly PendingReceipt[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  publish(queue);
}

function cleanupOrphanFiles(queue: readonly PendingReceipt[]): void {
  try {
    const dir = new Directory(Paths.document, PENDING_DIR);
    if (!dir.exists) return;
    const keep = new Set(queue.map((entry) => entry.fileName));
    const entries = (dir as unknown as { list?: () => unknown[] }).list?.() ?? [];
    for (const item of entries) {
      const file = item instanceof File ? item : null;
      if (!file || keep.has(file.name)) continue;
      try {
        if (file.exists) file.delete();
      } catch {
        // Best-effort orphan cleanup; continue with the rest.
      }
    }
  } catch {
    // Directory listing is best-effort and may not be available in every runtime.
  }
}

/** The durable file holding one pending capture's bytes. */
function pendingFile(entry: Pick<PendingReceipt, 'fileName'>): File {
  return new File(Paths.document, PENDING_DIR, entry.fileName);
}

/** The `file://` a gallery renders for a still-unsent capture. */
export function pendingReceiptUri(entry: Pick<PendingReceipt, 'fileName'>): string {
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
  cleanupOrphanFiles(queue);
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
  uploading.clear();
  publish([]);
}

/**
 * Park a picked image for later upload: write its bytes to a durable file and
 * record the queue entry. Returns the entry so the caller can show it at once.
 *
 * This runs for every add, online or not. Writing the bytes down first is what
 * makes the rest of the promise keepable — the capture survives the screen
 * closing, the app being killed, and the upload failing, because from this
 * moment the photograph exists somewhere other than memory.
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
    permanent: false,
    nextAttemptAt: null,
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

/**
 * Send failed captures again, now, at the person's asking.
 *
 * Everything the automatic path uses to hold a capture back is cleared: the
 * backoff window, the recorded failure, and the `permanent` mark. Clearing the
 * last of those is deliberate — the commonest permanent refusal is the
 * per-expense receipt ceiling, and the way somebody fixes that is to remove
 * another receipt and try this one again. Refusing to re-send would leave them
 * with a tile they had already done the work to un-block.
 *
 * It takes a list rather than one id so that clearing several and sending them
 * is a single write and a single flush. Retrying them one at a time would have
 * each call ride the single-flight coalescing in {@link flushReceiptQueue} and
 * possibly join a run that read the queue before its own clear landed.
 */
export async function retryPendingReceipts(attachmentIds: readonly string[]): Promise<FlushResult> {
  if (attachmentIds.length === 0) return EMPTY_FLUSH;
  const wanted = new Set(attachmentIds);
  const queue = await readQueue();
  await writeQueue(
    queue.map((entry) =>
      wanted.has(entry.attachmentId)
        ? { ...entry, lastError: null, permanent: false, nextAttemptAt: null }
        : entry,
    ),
  );
  return flushReceiptQueue();
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
  /**
   * True when at least one of those refusals was the per-expense receipt
   * ceiling — the one refusal somebody can actually do something about, so the
   * screen can offer the upgrade rather than a flat "didn't send".
   */
  capReached: boolean;
}

const EMPTY_FLUSH: FlushResult = {
  uploadedExpenseIds: [],
  hadPermanentFailure: false,
  capReached: false,
};

/**
 * Upload every pending capture that can be sent now. Best-effort and safe to
 * call often (screen mount, reconnect, foreground, launch): it no-ops when there
 * is nothing due or the device is offline, and each entry is handled in
 * isolation so one stuck capture never blocks the rest.
 *
 * On success the bytes move into the view cache (so the receipt stays offline-
 * readable) and the entry and its file are dropped. A transient failure keeps
 * the entry with a backoff, to be tried again on the next event; a permanent one
 * (cap, not a party) keeps it too, marked so no background run retries it —
 * either way the tile stays in the gallery saying what happened, and the bytes
 * stay on disk, until the person retries it or removes it.
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
  if (queue.length === 0) return EMPTY_FLUSH;

  // Only entries that are actually due: a permanent refusal waits for somebody
  // to ask, and a recent transient failure waits out its backoff. Both stay in
  // the queue and on screen — being skipped here is not the same as being gone.
  const now = Date.now();
  const due = queue.filter((entry) => {
    if (entry.permanent) return false;
    if (!entry.nextAttemptAt) return true;
    const at = Date.parse(entry.nextAttemptAt);
    return Number.isNaN(at) || at <= now;
  });
  if (due.length === 0) return EMPTY_FLUSH;
  if (!(await isOnline())) return EMPTY_FLUSH;

  // How each handled entry ends up: a replacement row, or null to drop it.
  // Applied against a re-read of the queue at the end, so entries parked *during*
  // the flush survive and everything keeps its original order.
  const updates = new Map<string, PendingReceipt | null>();
  const uploaded = new Set<string>();
  let hadPermanentFailure = false;
  let capReached = false;

  // Drive the in-app progress bar for the batch: one step per capture, marked
  // done as each is handled (uploaded, dropped, or failed). The bar is behind a
  // feature flag, but reporting is cheap and always on — the flag only decides
  // whether anything is drawn.
  startTransfer(FLUSH_TRANSFER_ID, due.length);
  let handled = 0;

  // The loop sits in try/finally so a throw from pendingFile/file.exists (which
  // run outside the per-entry try) still ends the transfer — otherwise the bar
  // sticks on screen at done < total until some later flush completes.
  try {
    for (const entry of due) {
      const file = pendingFile(entry);
      if (!file.exists) {
        // The bytes are gone (a wipe, a failed write) — nothing to send; drop it.
        updates.set(entry.attachmentId, null);
        handled += 1;
        setTransferProgress(FLUSH_TRANSFER_ID, handled);
        continue;
      }

      // From here the tile says "sending", live, wherever it is being rendered.
      markUploading(entry.attachmentId, true);
      // Whether the bytes reached storage on this attempt. The upload and the
      // row that makes it findable are two calls, and everything between them is
      // a window: succeed at the first and fail at the second and the object is
      // in the bucket with nothing pointing at it, counting against the group's
      // storage ceiling forever with no UI that can ever show or delete it.
      let objectStored = false;
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
        objectStored = true;
        const { error } = await backend.rpc('baaki_attach_expense_attachment', {
          p_expense_id: entry.expenseId,
          p_storage_path: entry.storagePath,
          p_visibility: entry.visibility,
          p_attachment_id: entry.attachmentId,
        });
        if (error) throw new Error(error.message);
        objectStored = false;

        // Uploaded and recorded. Keep it viewable offline by moving the bytes into
        // the view cache, then delete the pending file.
        cacheImageBytes('expense-attachments', entry.storagePath, new Uint8Array(decode(base64)));
        try {
          file.delete();
        } catch {
          // Best-effort; a lingering file is reclaimed with the app's document dir.
        }
        updates.set(entry.attachmentId, null);
        uploaded.add(entry.expenseId);
      } catch (caught) {
        // The bytes went up but the row did not: take the object back out, or it
        // is orphaned in the bucket with nothing able to reach it. The local file
        // is still here and still the source of truth, so a retry re-uploads it
        // to the same key — losing the remote copy costs nothing, keeping it
        // costs the group's storage allowance permanently. Best-effort by
        // design: a delete that fails must not mask the error that caused it,
        // which is what the queue entry below is recording.
        if (objectStored) {
          await removeRestrictedImage(
            'expense-attachments',
            entry.expenseId,
            entry.storagePath,
          ).catch(() => {});
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        const attempts = entry.attempts + 1;
        const permanent = isPermanent(message);
        if (permanent) {
          hadPermanentFailure = true;
          if (message.includes('ATTACHMENT_CAP')) capReached = true;
        }
        updates.set(entry.attachmentId, {
          ...entry,
          attempts,
          lastError: message,
          permanent,
          // A permanent refusal has no next attempt to schedule; a transient one
          // backs off so a phone flipping in and out of signal is not retried raw.
          nextAttemptAt: permanent
            ? null
            : new Date(Date.now() + backoffFor(attempts)).toISOString(),
        });
      } finally {
        markUploading(entry.attachmentId, false);
        handled += 1;
        setTransferProgress(FLUSH_TRANSFER_ID, handled);
      }
    }
  } finally {
    endTransfer(FLUSH_TRANSFER_ID);
  }

  // Re-read before writing back: enqueueReceipt may have appended during the
  // uploads above, and writing only what this run touched would silently drop it
  // (its bytes then orphaned under PENDING_DIR). Rebuilding from the current
  // queue keeps those, keeps the untouched entries, and preserves the order.
  const current = await readQueue();
  const next = current.flatMap((entry) => {
    if (!updates.has(entry.attachmentId)) return [entry];
    const replacement = updates.get(entry.attachmentId);
    return replacement ? [replacement] : [];
  });
  await writeQueue(next);
  return { uploadedExpenseIds: [...uploaded], hadPermanentFailure, capReached };
}
