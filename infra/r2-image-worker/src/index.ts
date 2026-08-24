/**
 * Waves R2 image normalizer (A44) — OPTIONAL fallback.
 *
 * Wakes on an R2 object-create event (delivered via a queue) and makes sure the
 * object is WebP. The phone encodes WebP itself whenever its platform can; this
 * catches the exception — chiefly iOS builds with no WebP encoder, whose
 * receipts and photos arrive as JPEG. Those are transcoded in place with the
 * Cloudflare Images binding and written back under the same key, so nothing
 * downstream (the ledger, the app's paths) has to change: only the bytes and the
 * content-type do.
 *
 * It is deliberately defensive: already-WebP objects, non-images, and anything
 * it cannot transcode are left exactly as they are. A worker that mangled an
 * original would be worse than one that never ran.
 */

interface Env {
  BUCKET: R2Bucket;
  // Optional: absent when the Images binding is not configured, in which case
  // the worker no-ops rather than failing.
  IMAGES?: {
    input: (stream: ReadableStream) => {
      transform: (opts: { format: string }) => {
        output: (opts: { format: string }) => Promise<{ response: () => Response }>;
      };
    };
  };
  // Optional: where to reconcile the storage ledger after a transcode shrinks an
  // object. Absent → the worker skips reconciliation (and must only run where the
  // storage cap is not enforced — see below).
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

interface R2EventRecord {
  object?: { key?: string };
  action?: string;
}

/** Keys we have already produced; re-processing our own output would loop. */
const ALREADY_WEBP = 'image/webp';

export default {
  async queue(batch: MessageBatch<R2EventRecord>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await normalize(message.body, env);
        message.ack();
      } catch (error) {
        // Let the queue retry (and eventually dead-letter) rather than dropping
        // the object silently.
        console.error('normalize failed', message.body?.object?.key, error);
        message.retry();
      }
    }
  },
};

async function normalize(record: R2EventRecord, env: Env): Promise<void> {
  const key = record.object?.key;
  if (!key || record.action === 'DeleteObject') return;
  if (!env.IMAGES) return; // No transcoder configured — nothing to do.

  const object = await env.BUCKET.get(key);
  if (!object) return;

  const contentType = object.httpMetadata?.contentType ?? '';
  if (contentType === ALREADY_WEBP) return; // Already what we want.
  if (!contentType.startsWith('image/')) return; // Not an image — leave it.
  // A guard against re-processing: our own writes carry this marker.
  if (object.customMetadata?.normalized === 'webp') return;

  const result = await env.IMAGES.input(object.body)
    .transform({ format: 'webp' })
    .output({ format: 'image/webp' });

  // `.response().body` is the transformed bytes as a stream — the shape R2's
  // `put` wants — without buffering the whole image in memory.
  const body = result.response().body;
  if (!body) return;

  // Write only if the object has not changed since we read it. A newer upload
  // could have replaced `key` between the `get` and this `put`; without the
  // guard we would clobber those newer bytes with our stale transcode. A failed
  // conditional write returns null — bail and let the newer event process the
  // current object.
  const written = await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: ALREADY_WEBP },
    customMetadata: { ...object.customMetadata, normalized: 'webp' },
    onlyIf: { etagMatches: object.etag },
  });
  if (!written) return;

  // Reconcile the storage ledger: the transcode shrank the object, but the ledger
  // still holds the pre-transcode size, so the free-tier cap would over-count
  // until the next re-upload. `storage-recount` HEADs the new size and rewrites
  // the row. If the callback is not configured the worker MUST only run where the
  // cap is not enforced (see docs/r2-storage.md).
  await reconcileLedger(key, env);
}

/**
 * Tell the backend the object's size changed, via the service-gated
 * `storage-recount` edge function. Best-effort and idempotent: a miss is retried
 * on the next normalization of the same key, and recount only ever corrects a
 * committed row's size.
 */
async function reconcileLedger(key: string, env: Env): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;

  // The R2 key is `<logicalBucket>/<path>`; split off the first segment.
  const slash = key.indexOf('/');
  if (slash <= 0) return;
  const bucket = key.slice(0, slash);
  const path = key.slice(slash + 1);

  const response = await fetch(`${env.SUPABASE_URL}/functions/v1/storage-recount`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ bucket, path }),
  });
  if (!response.ok) {
    // Surface for retry rather than silently drifting the cap.
    throw new Error(`storage-recount failed (${response.status})`);
  }
}
