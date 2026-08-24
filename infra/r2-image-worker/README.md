# Waves R2 image worker (optional)

The phone encodes WebP whenever its platform can. This worker is the **fallback**
for the objects it could not — chiefly iOS builds without a WebP encoder, whose
images land as JPEG. It transcodes any non-WebP object to WebP in place, so
storage and downloads converge on WebP regardless of the device.

**The app does not need this worker to function.** WebP-on-device covers the
common case; this only shrinks the JPEG-fallback minority. Deploy it when you
want that last bit of consistency, skip it otherwise.

## What it does

1. R2 emits an `object-create` event to a queue on every upload.
2. This worker consumes the event, `GET`s the object, and — if it is an image
   that is not already WebP — transcodes it with the Cloudflare Images binding
   and writes it back under the same key with `content-type: image/webp`.
3. Already-WebP objects, non-images, and its own previous output are skipped.

The object key never changes, so nothing in the database or the app has to know
this ran.

## Setup

Requires [Cloudflare Images](https://developers.cloudflare.com/images/) enabled
on the account (the `[images]` binding). Without it the worker no-ops safely.

```sh
cd infra/r2-image-worker
npm install    # wrangler

# 1. Create the queue + dead-letter queue
wrangler queues create waves-image-events
wrangler queues create waves-image-events-dlq

# 2. Point the R2 bucket's create events at the queue
wrangler r2 bucket notification create waves-images \
  --event-type object-create --queue waves-image-events

# 3. Edit wrangler.toml: set bucket_name to your R2 bucket
# 4. Deploy
wrangler deploy
```

## Notes

- **In place, same key.** Transcoding preserves the key the ledger recorded, so
  the recorded byte count can differ slightly from the final WebP size. The cap
  is measured at `commit` time from the uploaded bytes; a later shrink only ever
  frees space, so this never pushes a user over their ceiling.
- **Idempotent.** A `normalized=webp` custom-metadata marker stops the worker
  re-processing its own output if an event is redelivered.
- **Failures retry.** A transcode error `retry()`s the message; after
  `max_retries` it dead-letters for inspection rather than corrupting the object.
