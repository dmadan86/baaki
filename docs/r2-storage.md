# Image storage on Cloudflare R2 (A44)

Receipts, group photos, avatars and captures are stored in **Cloudflare R2**.
The **mobile client** reaches R2 only through the `r2-sign` edge function — it
never holds an R2 credential, so it asks the function for a **presigned** PUT/GET
and talks to R2 directly with that URL. **Server-side** code (`receipt-parse`,
the `storage-sweep` job, `_shared/r2.ts`) uses the R2 S3 credentials directly, as
it must to read bytes back and reclaim objects. Free accounts have a **10 MB**
aggregate image-storage ceiling; paid accounts (and any group whose owner is
paid) are uncapped.

This is shipped **behind a flag and off by default** — with the flag off, the app
uses Supabase Storage exactly as before, so nothing breaks until the secrets
below exist and the flag is turned on.

## What you (the operator) still owe

1. **Create the R2 bucket** in the Cloudflare dashboard (e.g. `waves-images`).
2. **Create an R2 API token** (S3 credentials) scoped to that bucket — an access
   key id + secret. This is the credential that lives only on the server.
3. **Set the edge-function secrets** (below) in Supabase.
4. **Set `EXPO_PUBLIC_R2_ENABLED=true`** in the mobile build and ship it.
5. _(Optional)_ deploy the WebP-normalizer worker — see
   `infra/r2-image-worker/README.md`.

Until step 4, uploads keep landing in Supabase Storage. After it, **new** uploads
go to R2 and old images keep serving from Supabase (dual-read) — there is no
backfill.

## Edge-function secrets (Supabase)

Set on the project so both `r2-sign` and `receipt-parse` can reach R2:

```sh
supabase secrets set \
  R2_ACCOUNT_ID=<cloudflare-account-id> \
  R2_BUCKET=waves-images \
  R2_ACCESS_KEY_ID=<r2-access-key-id> \
  R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
```

| Secret                                      | What it is                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `R2_ACCOUNT_ID`                             | Cloudflare account id (the R2 S3 endpoint is `https://<id>.r2.cloudflarestorage.com`). |
| `R2_BUCKET`                                 | The one physical R2 bucket; every image is keyed `<logicalBucket>/<path>` inside it.   |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 S3 API token. **Server only — never in the app bundle.**                            |

Deploy the functions after setting secrets:

```sh
supabase functions deploy r2-sign
supabase functions deploy receipt-parse    # now also reads from R2
supabase functions deploy storage-sweep    # reclaims stranded R2 objects
supabase functions deploy storage-recount  # only if the WebP worker runs
```

### Schedule the sweep (reclaims stranded R2 bytes)

The database frees the **cap** on its own — a `pg_cron` job runs
`waves_storage_expire_pending()` every 15 minutes to drop reservations nobody
committed, so an abandoned upload stops holding a person's ceiling without any R2
credential. Reclaiming the actual R2 **bytes** (expired reservations, deleted
objects, and objects orphaned when a profile or group is deleted) needs an R2
credential, so it lives in the `storage-sweep` edge function. Schedule it wherever
you run periodic jobs — e.g. a Supabase scheduled function, or `pg_cron` +
`pg_net` posting to the function with the service-role key.

First store the service-role key in **Supabase Vault**, which keeps it encrypted
at rest — never in a plain database GUC or setting, which any `anon`/`authenticated`
role could read back with `current_setting` and use to bypass RLS:

```sql
select vault.create_secret('<service-role-key>', 'service_role_key');
```

Then schedule the POST to the function's canonical URL
(`https://<project-ref>.supabase.co/functions/v1/storage-sweep`), reading the key
from the Vault at run time:

```sql
select cron.schedule(
  'waves-storage-sweep', '*/30 * * * *',
  $$ select net.http_post(
       url     := 'https://<project-ref>.supabase.co/functions/v1/storage-sweep',
       headers := jsonb_build_object(
         'Authorization',
         'Bearer ' || (select decrypted_secret
                         from vault.decrypted_secrets
                        where name = 'service_role_key')
       )
     ) $$
);
```

The two jobs do different things: the **`waves-storage-expire-pending`** DB cron
(installed by the migration) frees the **cap** held by abandoned reservations,
needing no R2 credential; **`storage-sweep`** deletes the actual **R2 objects**
(expired reservations, deleted images, cascade orphans). If `storage-sweep` never
runs, the cap stays exactly correct — only reclaimable R2 storage accumulates.

## Mobile flag

```dotenv
EXPO_PUBLIC_R2_ENABLED=true
```

Off/absent → direct Supabase Storage (the pre-A44 behaviour). `true` → the storage
seam brokers everything through `r2-sign`.

## Database

The migration `20260824120000_r2_storage_cap` adds:

- `storage_objects` — the ledger of every R2 object (owner, group, bytes, whether
  it counts against a cap, and whether it is still a `pending` reservation).
  Written only by the service role.
- `storage_orphans` — a queue of R2 keys whose ledger row is gone (deleted,
  expired, or cascaded away) and which the sweep still has to remove from R2.
- `app_config.free_storage_cap_bytes` — the 10 MB knob (admin-editable, like the
  receipt cap). Raise or lower it without a deploy.
- `waves_storage_reserve` (presign gate) / `waves_storage_record` (commit) /
  `waves_storage_release` / `waves_storage_release_reservation` (failure cleanup)
  / `waves_storage_recount` (worker size reconcile) / `waves_storage_expire_pending`
  / `waves_storage_orphans` / `waves_storage_orphan_clear` / `waves_my_storage_usage`
  / `waves_storage_counts` / `waves_profiles_share_group`.
- a `pg_cron` job `waves-storage-expire-pending` (every 15 min) that frees the cap
  held by abandoned reservations.

Apply it with the normal migrate deploy.

## The cap rule (A44)

- A **paid** uploader is never capped and never counted.
- An upload into a group whose **owner is paid** is uncapped for everyone in it.
- Otherwise the bytes count against the **uploader's** 10 MB ceiling — receipts,
  group photos and avatars alike; personal images (no group) count too.
- Reserved at the **presign** (so a presign the client never commits still counts,
  and cannot fill R2 for free) and re-checked at **commit** against the object's
  true HEADed size (the real boundary): an over-cap upload is deleted from R2 and
  answered `402 STORAGE_CAP`, which the app turns into an upgrade prompt.
- Every reserve/commit for one account is **serialised by a per-owner advisory
  lock**, so two uploads racing the ceiling cannot both slip under it.
- An account may hold at most **8 uncommitted reservations** at once; abandoned
  ones are swept after 30 minutes, freeing the cap they held.
