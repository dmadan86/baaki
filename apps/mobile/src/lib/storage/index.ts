/**
 * One seam for every image the app stores (A44).
 *
 * Historically each uploader called `supabase.storage.from(bucket)…` inline.
 * Storage now has two backends — Cloudflare R2 for everything uploaded since the
 * cut-over, Supabase Storage for anything before it — and the client must not
 * care which. Every read, write and delete goes through here.
 *
 * When R2 is switched on (`EXPO_PUBLIC_R2_ENABLED`), writes are brokered by the
 * `r2-sign` edge function: the client holds no R2 credential, so it asks for a
 * presigned PUT, uploads straight to R2, then asks the function to record the
 * object (which is where the free-tier storage ceiling is enforced). Reads ask
 * the same function for a URL and it resolves whichever backend holds the object.
 *
 * With R2 off, this is exactly the old behaviour — a direct Supabase Storage
 * call — so the seam is safe to ship before any R2 secret exists.
 */

import { decode } from 'base64-arraybuffer';

import { supabase } from '@/lib/supabase';

/** The four private buckets. Values match the R2 namespace and the old bucket. */
export type LogicalBucket = 'receipts' | 'group-photos' | 'avatars' | 'captures';

/**
 * The free-tier storage ceiling was hit. Thrown so a caller can show the upgrade
 * prompt instead of a generic failure — the one refusal the person can act on.
 */
export class StorageCapError extends Error {
  constructor(message = 'You have reached your free storage limit.') {
    super(message);
    this.name = 'StorageCapError';
  }
}

export function r2Enabled(): boolean {
  return process.env.EXPO_PUBLIC_R2_ENABLED === 'true';
}

const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Turn a failed `r2-sign` invocation into either a `StorageCapError` (a 402 the
 * caller handles) or a plain Error. supabase-js hands back the raw `Response` on
 * a non-2xx, so the JSON `code` is read from there.
 */
async function asStorageError(error: unknown): Promise<Error> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const parsed = (await context.clone().json()) as { code?: string; message?: string };
      if (parsed.code === 'STORAGE_CAP') return new StorageCapError(parsed.message);
      if (parsed.message) return new Error(parsed.message);
    } catch {
      // Not JSON — fall through to the generic message below.
    }
  }
  return error instanceof Error ? error : new Error('Storage request failed');
}

async function signCall(body: Record<string, unknown>): Promise<{ url?: string }> {
  const { data, error } = await supabase.functions.invoke('r2-sign', { body });
  if (error) throw await asStorageError(error);
  return (data ?? {}) as { url?: string };
}

export interface PutImageInput {
  bucket: LogicalBucket;
  /** Object path within the bucket, e.g. `<groupId>/cover.webp`. */
  path: string;
  base64: string;
  contentType: string;
  /** The group the bytes are charged to, for the storage-cap rule. */
  groupId?: string | null;
}

/**
 * Store an image and return its path (unchanged — the path is what the owning
 * row keeps, so nothing downstream has to learn a new value).
 *
 * @throws {StorageCapError} when a free account is out of storage.
 */
export async function putImage(input: PutImageInput): Promise<string> {
  const bytes = decode(input.base64);

  if (!r2Enabled()) {
    const { error } = await supabase.storage
      .from(input.bucket)
      .upload(input.path, bytes, { contentType: input.contentType, upsert: true });
    if (error) throw new Error(error.message);
    return input.path;
  }

  const { url } = await signCall({
    action: 'put',
    bucket: input.bucket,
    path: input.path,
    contentType: input.contentType,
    contentLength: bytes.byteLength,
    groupId: input.groupId ?? null,
  });
  if (!url) throw new Error('Could not start the upload');

  // Straight to R2 with the presigned URL. The same ArrayBuffer the Supabase
  // SDK uploads today, PUT by hand.
  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': input.contentType },
    body: bytes,
  }).catch((cause) => {
    throw new Error(`Upload failed: ${cause instanceof Error ? cause.message : 'network error'}`);
  });
  if (!put.ok) {
    // `put` already reserved this path's bytes against the cap. The upload did
    // not land, so release the reservation rather than leave it holding cap until
    // the 30-minute sweep. Best-effort: the sweep is the backstop either way.
    await signCall({ action: 'delete', bucket: input.bucket, path: input.path }).catch(() => {});
    throw new Error(`Upload failed (${put.status})`);
  }

  // Record it — and hit the real cap boundary, which can still refuse here.
  await signCall({
    action: 'commit',
    bucket: input.bucket,
    path: input.path,
    contentType: input.contentType,
    groupId: input.groupId ?? null,
  });
  return input.path;
}

/**
 * Resolve an object path to a displayable URL, or null when it cannot be
 * resolved — a missing image is a blank, never a thrown screen.
 */
export async function imageUrl(bucket: LogicalBucket, path: string | null): Promise<string | null> {
  if (!path) return null;

  if (!r2Enabled()) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error) return null;
    return data?.signedUrl ?? null;
  }

  try {
    const { url } = await signCall({ action: 'get', bucket, path });
    return url ?? null;
  } catch {
    return null;
  }
}

/** Delete an object from whichever backend holds it. */
export async function removeImage(bucket: LogicalBucket, path: string | null): Promise<void> {
  if (!path) return;

  if (!r2Enabled()) {
    await supabase.storage.from(bucket).remove([path]);
    return;
  }
  await signCall({ action: 'delete', bucket, path });
}
