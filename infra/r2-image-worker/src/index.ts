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
        output: (opts: { format: string }) => Promise<{ image: () => ReadableStream }>;
      };
    };
  };
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

  await env.BUCKET.put(key, result.image(), {
    httpMetadata: { contentType: ALREADY_WEBP },
    customMetadata: { ...object.customMetadata, normalized: 'webp' },
  });
}
