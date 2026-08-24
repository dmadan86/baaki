/**
 * storage-recount — reconcile a committed object's size after it was rewritten
 * out-of-band (A44).
 *
 * The optional R2 image worker transcodes an object to WebP in place, which
 * shrinks it; the `storage_objects` ledger still holds the pre-transcode size, so
 * the free-tier cap would over-count until the next re-upload. The worker POSTs
 * `{bucket, path}` here after it rewrites the object; this HEADs the object for
 * its true size and records it (`baaki_storage_recount`).
 *
 * Like the sweep, this is the service role's business — the gate is the service
 * key, not a user JWT — because it is called machine-to-machine by the worker.
 */

import { asService, serveWithCors, errorResponse, HttpError, json } from '../_shared/auth.ts';
import { LOGICAL_BUCKETS, type LogicalBucket, objectUrl, r2, r2Configured } from '../_shared/r2.ts';

serveWithCors(async (request) => {
  try {
    if (request.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST {bucket, path} to reconcile a size');
    }

    const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!expected || request.headers.get('Authorization') !== `Bearer ${expected}`) {
      throw new HttpError(401, 'NOT_AUTHORISED', 'This endpoint is not for clients');
    }
    if (!r2Configured()) {
      throw new HttpError(503, 'R2_NOT_CONFIGURED', 'R2 is not configured on this deployment');
    }

    const body = (await request.json().catch(() => ({}))) as { bucket?: unknown; path?: unknown };
    const bucket = body.bucket;
    const path = body.path;
    if (typeof bucket !== 'string' || !LOGICAL_BUCKETS.includes(bucket as LogicalBucket)) {
      throw new HttpError(400, 'BAD_BUCKET', 'Unknown storage bucket');
    }
    if (typeof path !== 'string' || path.length === 0 || path.length > 512) {
      throw new HttpError(400, 'BAD_PATH', 'Missing object path');
    }

    const head = await r2().client.fetch(objectUrl(bucket as LogicalBucket, path), {
      method: 'HEAD',
    });
    if (!head.ok) throw new HttpError(404, 'NOT_FOUND', 'Object not found in R2');
    const size = Number(head.headers.get('content-length') ?? '0');
    const contentType = head.headers.get('content-type') ?? 'image/webp';

    const service = asService();
    const { error } = await service.rpc('baaki_storage_recount', {
      p_logical_bucket: bucket,
      p_path: path,
      p_bytes: size,
      p_content_type: contentType,
    });
    if (error) throw new HttpError(500, 'INTERNAL', error.message);

    return json({ ok: true, bytes: size });
  } catch (error) {
    return errorResponse(error, { fn: 'storage-recount' });
  }
});
