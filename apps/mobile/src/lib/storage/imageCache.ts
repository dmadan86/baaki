/**
 * An on-device cache for receipt images, so a bill you have opened once stays
 * readable with no network — the offline half of ADR-005 applied to images.
 *
 * The problem it solves: receipt bytes live behind short-lived signed URLs
 * (`r2-sign`), and the signature rotates every time, so expo-image's own
 * URL-keyed disk cache never gets a hit — and offline the URL cannot even be
 * minted. This keeps the bytes under a stable key (the object's storage path),
 * so the same image resolves to a local `file://` that works on a plane.
 *
 * It lives in `Paths.cache`, which the OS may reclaim under storage pressure —
 * correct for a cache: a purge only means the next online view re-downloads it,
 * never lost data. Every call is best-effort and swallows its own errors: a
 * cache miss or a write failure must degrade to the online path, never throw a
 * receipt view.
 */

import { randomUUID } from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';

import type { LogicalBucket } from './index';

/** Subdirectory under the OS cache dir that holds every cached receipt image. */
const CACHE_DIR = 'receipt-image-cache';

/** Downloads already in flight, keyed by the stable local cache identity. */
const inFlightDownloads = new Map<string, Promise<string | null>>();

/**
 * Bumped by {@link clearImageCache}. A download started before a sign-out
 * captures this value and refuses to write its bytes if it has changed by the
 * time the response lands — otherwise a fetch still in flight when the account
 * signs out would recreate the just-deleted cache and leave a private image on
 * disk, defeating the whole point of the cleanup.
 */
let cacheGeneration = 0;

function usablePath(path: string | null): string | null {
  if (!path || path.trim().length === 0) return null;
  return path;
}

/**
 * Write bytes to the cache atomically: to a unique temp sibling first, then move
 * it onto the final path. A direct `file.write` can leave a truncated file if
 * the process is killed mid-write, and `cachedImageUri` accepts any existing
 * file — so a later read would hand back half an image. The move is the last,
 * near-atomic step, so a reader only ever sees the whole file or none. The temp
 * name is random so two writers to the same key never collide.
 */
function writeAtomic(dir: Directory, file: File, bytes: Uint8Array): void {
  if (!dir.exists) dir.create({ intermediates: true });
  const temp = new File(dir, `.${randomUUID()}.tmp`);
  try {
    temp.write(bytes);
    temp.moveSync(file, { overwrite: true });
  } catch (err) {
    try {
      if (temp.exists) temp.delete();
    } catch {
      // Best-effort cleanup; a stray temp is reclaimed with the cache dir.
    }
    throw err;
  }
}

/**
 * A deterministic, filesystem-safe filename for a stored object. The bucket and
 * path together are unique. They are URI-encoded as one string rather than
 * lossy-flattened, so distinct storage paths like `a/b` and `a_b` cannot map to
 * the same local file.
 */
function fileFor(bucket: LogicalBucket, path: string): File {
  const name = encodeURIComponent(`${bucket}\u0000${path}`);
  return new File(Paths.cache, CACHE_DIR, name);
}

function fileSize(file: File): number {
  const size = (file as unknown as { size?: unknown }).size;
  return typeof size === 'number' ? size : 0;
}

function isNonEmptyFile(file: File): boolean {
  return file.exists && fileSize(file) > 0;
}

function deleteIfExists(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Best-effort cache cleanup.
  }
}

/**
 * The local `file://` for a cached object, or null when it is not on disk. Sync
 * and cheap (a stat), so a resolver can check it first on every render before
 * reaching for the network.
 */
export function cachedImageUri(bucket: LogicalBucket, path: string | null): string | null {
  const key = usablePath(path);
  if (!key) return null;
  try {
    const file = fileFor(bucket, key);
    return isNonEmptyFile(file) ? file.uri : null;
  } catch {
    return null;
  }
}

/**
 * Download an already-resolved remote URL into the cache under its stable key,
 * so the next view — online or off — reads the local copy. Returns the local
 * `file://` on success, or null on any failure (the caller then keeps showing
 * the remote URL). A no-op when the bytes are already cached.
 */
export async function cacheImage(
  bucket: LogicalBucket,
  path: string | null,
  remoteUrl: string,
): Promise<string | null> {
  const key = usablePath(path);
  if (!key) return null;
  try {
    const file = fileFor(bucket, key);
    if (isNonEmptyFile(file)) return file.uri;
    if (file.exists) deleteIfExists(file);

    const inFlightKey = file.uri;
    const existing = inFlightDownloads.get(inFlightKey);
    if (existing) return await existing;

    // Snapshot the cache generation now: if a sign-out clears the cache while
    // this fetch is in flight, the generation moves and we drop the bytes rather
    // than writing them back into a cache the user just erased.
    const generation = cacheGeneration;
    const download = (async () => {
      try {
        const response = await expoFetch(remoteUrl);
        if (!response.ok) return null;
        const bytes = await response.bytes();
        if (bytes.byteLength === 0) return null;
        if (generation !== cacheGeneration) return null;
        writeAtomic(new Directory(Paths.cache, CACHE_DIR), file, bytes);
        return file.uri;
      } catch {
        return null;
      } finally {
        inFlightDownloads.delete(inFlightKey);
      }
    })();
    inFlightDownloads.set(inFlightKey, download);
    return await download;
  } catch {
    return null;
  }
}

/**
 * Seed the cache directly from bytes already on the device — used the moment a
 * queued offline capture finishes uploading, so the receipt stays viewable with
 * no network without a needless round-trip to re-download what we just sent.
 * Best-effort; returns the local `file://` or null.
 */
export function cacheImageBytes(
  bucket: LogicalBucket,
  path: string,
  bytes: Uint8Array,
): string | null {
  const key = usablePath(path);
  if (!key || bytes.byteLength === 0) return null;
  try {
    const file = fileFor(bucket, key);
    writeAtomic(new Directory(Paths.cache, CACHE_DIR), file, bytes);
    return file.uri;
  } catch {
    return null;
  }
}

/**
 * Drop a cached object — called when its source is removed or replaced, so a
 * stale copy cannot outlive the real one. Best-effort.
 */
export function evictImage(bucket: LogicalBucket, path: string | null): void {
  const key = usablePath(path);
  if (!key) return;
  try {
    const file = fileFor(bucket, key);
    if (file.exists) file.delete();
  } catch {
    // Already gone, or unreadable — nothing to do.
  }
}

/** Sign-out/privacy cleanup: remove every cached receipt/proof/attachment image. */
export function clearImageCache(): void {
  // Move the generation first, so any download already awaiting a response sees
  // the change and skips its write even if it resolves after this returns.
  cacheGeneration += 1;
  try {
    const dir = new Directory(Paths.cache, CACHE_DIR);
    if (dir.exists) dir.delete();
  } catch {
    // Best-effort cache cleanup.
  } finally {
    inFlightDownloads.clear();
  }
}
