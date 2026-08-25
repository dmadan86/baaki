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

import { fetch as expoFetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';

import type { LogicalBucket } from './index';

/** Subdirectory under the OS cache dir that holds every cached receipt image. */
const CACHE_DIR = 'receipt-image-cache';

/**
 * A deterministic, filesystem-safe filename for a stored object. The bucket and
 * path together are unique, and every character a path can carry (slashes, the
 * uuid dots) is flattened to `_` so it is one flat filename rather than a nested
 * tree — the lookup only needs identity, not the original shape.
 */
function fileFor(bucket: LogicalBucket, path: string): File {
  const name = `${bucket}__${path}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return new File(Paths.cache, CACHE_DIR, name);
}

/**
 * The local `file://` for a cached object, or null when it is not on disk. Sync
 * and cheap (a stat), so a resolver can check it first on every render before
 * reaching for the network.
 */
export function cachedImageUri(bucket: LogicalBucket, path: string | null): string | null {
  if (!path) return null;
  try {
    const file = fileFor(bucket, path);
    return file.exists ? file.uri : null;
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
  if (!path) return null;
  try {
    const file = fileFor(bucket, path);
    if (file.exists) return file.uri;

    const dir = new Directory(Paths.cache, CACHE_DIR);
    if (!dir.exists) dir.create({ intermediates: true });

    const response = await expoFetch(remoteUrl);
    if (!response.ok) return null;
    const bytes = await response.bytes();
    file.write(bytes);
    return file.uri;
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
  try {
    const file = fileFor(bucket, path);
    const dir = new Directory(Paths.cache, CACHE_DIR);
    if (!dir.exists) dir.create({ intermediates: true });
    file.write(bytes);
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
  if (!path) return;
  try {
    const file = fileFor(bucket, path);
    if (file.exists) file.delete();
  } catch {
    // Already gone, or unreadable — nothing to do.
  }
}
