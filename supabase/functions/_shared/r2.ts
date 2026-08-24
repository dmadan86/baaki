/**
 * Cloudflare R2 access for edge functions (A44).
 *
 * One physical R2 bucket holds every image, namespaced by the old Supabase
 * bucket name: the key for an object is `<logicalBucket>/<path>`. The client
 * never reaches R2 directly — `r2-sign` brokers presigned URLs — but the server
 * side (receipt OCR) still has to read a receipt image back, and it may live in
 * R2 or, for anything uploaded before the cut-over, in Supabase Storage. This
 * module is the shared seam both concerns build on.
 */

import { AwsClient } from 'npm:aws4fetch@1';

import { HttpError, type SupabaseClient } from './auth.ts';

export const LOGICAL_BUCKETS = [
  'receipts',
  'group-photos',
  'avatars',
  'captures',
  'trip-photos',
] as const;
export type LogicalBucket = (typeof LOGICAL_BUCKETS)[number];

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, 'MISCONFIGURED', `${name} is not set`);
  return value;
}

/** True when R2 is configured at all — lets a server path fall back cleanly. */
export function r2Configured(): boolean {
  return Boolean(
    Deno.env.get('R2_ACCOUNT_ID') &&
    Deno.env.get('R2_BUCKET') &&
    Deno.env.get('R2_ACCESS_KEY_ID') &&
    Deno.env.get('R2_SECRET_ACCESS_KEY'),
  );
}

let client: AwsClient | null = null;

export function r2(): { client: AwsClient; endpoint: string; bucket: string } {
  const accountId = requiredEnv('R2_ACCOUNT_ID');
  const bucket = requiredEnv('R2_BUCKET');
  if (!client) {
    client = new AwsClient({
      accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
      service: 's3',
      region: 'auto',
    });
  }
  return { client, endpoint: `https://${accountId}.r2.cloudflarestorage.com`, bucket };
}

/** The S3 URL for an object, each path segment percent-encoded. */
export function objectUrl(logicalBucket: LogicalBucket, path: string): string {
  const { endpoint, bucket } = r2();
  const key = `${logicalBucket}/${path}`
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${endpoint}/${bucket}/${key}`;
}

/**
 * Read an object's bytes for server-side use, from whichever backend holds it.
 *
 * The ledger is the source of truth for "is this in R2": a row means yes. Absent
 * a row the object predates the migration and is fetched from Supabase Storage
 * with the service role — the same dual-read `r2-sign`'s `get` performs, but
 * returning bytes rather than a URL.
 */
export async function readObjectBytes(
  service: SupabaseClient,
  logicalBucket: LogicalBucket,
  path: string,
): Promise<Uint8Array> {
  if (r2Configured()) {
    const { data, error } = await service
      .from('storage_objects')
      .select('path')
      .eq('logical_bucket', logicalBucket)
      .eq('path', path)
      .maybeSingle();
    // A lookup failure is not "the object is on the old backend" — falling through
    // on error would fetch the wrong place or 404 a live R2 object. Surface it.
    if (error) throw new HttpError(500, 'LEDGER_LOOKUP_FAILED', error.message);
    if (data) {
      const response = await r2().client.fetch(objectUrl(logicalBucket, path));
      if (!response.ok) throw new HttpError(404, 'NOT_FOUND', 'Object not found in R2');
      return new Uint8Array(await response.arrayBuffer());
    }
  }

  const { data, error } = await service.storage.from(logicalBucket).download(path);
  if (error || !data) throw new HttpError(404, 'NOT_FOUND', 'Object not found');
  return new Uint8Array(await data.arrayBuffer());
}
