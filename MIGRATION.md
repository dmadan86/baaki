# Migrating Waves off Supabase

How to move Waves from Supabase's cloud to **anywhere else** — a self-hosted box,
another managed Postgres, AWS / GCP / Azure, or a private VPS — without rewriting
the app. Read this with [`infra/self-host/`](infra/self-host/README.md), which
boots the escape-hatch stack the first two paths use.

---

## 1. What is actually locked in

Most of Waves is **not** Supabase-specific. Be honest about the split before
planning any move:

| Layer                                      | Where                                  | Portability                                   |
| ------------------------------------------ | -------------------------------------- | --------------------------------------------- |
| Schema, RLS, RPCs, triggers, cron          | `packages/db` (Prisma)                 | **Plain Postgres.** Runs anywhere.            |
| Money/split logic                          | `@waves/core`                          | Pure TS. No backend at all.                   |
| Image storage                              | `apps/mobile/src/lib/storage`, R2      | **Already provider-neutral** (Cloudflare R2). |
| Reads (`.from().select()`)                 | mobile `data/api.ts`, web `api-client` | PostgREST — open source, self-hostable.       |
| Auth (anon guest, in-place upgrade, OAuth) | `api-client`, mobile `lib/auth.tsx`    | **GoTrue — the stickiest piece.**             |
| Edge functions (15, Deno)                  | `supabase/functions/*`                 | Portable code, Supabase deploy target.        |
| `pg_net` HTTP-from-DB (push fan-out)       | `push_fanout` migration                | **The one real hard dependency.** See §6.     |

The takeaway: "leave Supabase" is really "re-home GoTrue, PostgREST, the edge
runtime, and the data." All four are open source. None require touching app code
if you keep running them (§3). Only a move to _native cloud primitives_ (§4)
touches code — and even then, behind a seam, incrementally.

---

## 2. Pick a target

| Path                                    | Effort | App code change        | When                                                                          |
| --------------------------------------- | ------ | ---------------------- | ----------------------------------------------------------------------------- |
| **A. Self-host the same stack**         | Low    | **None** (one env var) | Escape Supabase pricing/lock; keep everything else.                           |
| **B. Managed Postgres + self-host aux** | Medium | Small (§6 pg_net only) | Want a cloud provider's managed DB (RDS/Cloud SQL) but keep GoTrue/PostgREST. |
| **C. Native cloud** (Cognito, own API)  | High   | Large, but seam-able   | Full independence, willing to replace auth + read layer.                      |

**Recommended:** A first (it's insurance you can stand up today), then B if a
specific cloud is mandated. C only if you truly must shed GoTrue/PostgREST — and
only after the code seam (the "option A / ports" work) exists.

---

## 3. Path A — self-host the same stack (no app rewrite)

1. **Stand up the stack** on the target host — see `infra/self-host/README.md`.
   Same on a laptop, an EC2/GCE/Azure VM, or a VPS.
2. **Recreate `public`** with Prisma:
   ```bash
   DATABASE_URL=postgres://postgres:<pw>@<host>:5432/postgres \
   DIRECT_URL=postgres://postgres:<pw>@<host>:5432/postgres \
   pnpm --filter @waves/db exec prisma migrate deploy
   ```
3. **Move the data** — §5.
4. **Redeploy edge functions** — they already run in the stack's Edge runtime
   from the mounted `supabase/functions/*`. Just fill `functions.env`.
5. **Flip the app** — set `EXPO_PUBLIC_SUPABASE_URL` (+ `ANON_KEY`) to the new
   gateway, ship an OTA update (mobile) / redeploy (web). Done.

Because GoTrue, PostgREST and the Edge runtime are byte-for-byte the same
software, the app cannot tell the difference. This is the whole point.

---

## 4. Path C — native cloud (only with the code seam)

This is the only path that edits app code. Do it **behind ports**, one adapter
at a time, never as a big-bang rewrite:

- **Reads** — replace PostgREST with your own REST/GraphQL service (or run
  PostgREST standalone in front of the managed DB — cheapest). The `.select()`
  embed strings are the coupling; a `DataPort` interface hides them.
- **Auth** — replace GoTrue with Cognito / Clerk / Keycloak behind an `AuthPort`.
  ⚠️ **Preserve `auth.users.id` UUIDs** — they are `profile_id` across the whole
  ledger. And **anonymous guest + in-place upgrade (ADR-006) is a GoTrue
  feature** with no drop-in equivalent; budget real work to reproduce it, or
  keep GoTrue just for that flow.
- **Functions** — Deno code runs on Deno Deploy, or port to Node/Lambda.
- **Storage** — already R2; nothing to do.

The port interfaces + adapter wrapping is the separate "option A" workstream.
Land that first; then C is writing one adapter class and a data move.

---

## 5. The data migration (Supabase → any Postgres)

Scripts in `infra/self-host/scripts/`. The principle: **structure from Prisma,
data from `pg_dump`, UUIDs preserved.**

```bash
cd infra/self-host/scripts

# 1. Pull from the cloud (DIRECT connection, port 5432 — not the pooler).
export SOURCE_DB_URL="postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres"
./dump-from-supabase.sh          # -> out/auth.sql, out/public.sql, out/public.schema.sql

# 2. Target must already have `public` STRUCTURE (Prisma migrate deploy, §3.2)
#    and the stack must be UP (so GoTrue created the auth tables).

# 3. Load: auth users first (FKs), then public data.
export TARGET_DB_URL="postgres://postgres:<pw>@<target-host>:5432/postgres"
./restore-to-selfhost.sh ./out   # prints row counts to compare against source
```

Notes:

- **Auth users keep their UUIDs.** `auth.sql` is data-only for `auth.users` +
  `auth.identities`. Never let a new auth system regenerate ids — every
  `profile_id` FK would dangle.
- **`public` is data-only.** Structure comes from Prisma so RLS/RPCs/cron are
  identical to prod; loading data-only avoids owner/permission mismatches.
- **`_prisma_migrations` is excluded** from the data load — the target already
  has its own from `migrate deploy`.
- **Storage objects:** new ones are already in R2 (nothing to move). Pre-R2
  objects still in Supabase Storage → `rclone`/S3-sync the buckets to R2 or the
  target's `storage-data` volume. Waves' `lib/storage` dual-reads during the
  window.

---

## 6. `pg_net` and cron — the one thing to watch

- **Self-host / `supabase/postgres` image (Path A):** `pg_net` and `pg_cron`
  are present. Push fan-out and the scheduled jobs (auto-archive, settlement
  auto-confirm, storage sweep) run **unchanged**.
- **Vanilla managed Postgres (Path B/C — RDS, Cloud SQL, Azure DB):** no
  `pg_net`. The `notify-fanout` path that calls HTTP from inside the DB must be
  replaced with an **external worker** — a small process (or the edge function
  on a cron) that polls the fan-out queue table and makes the HTTP calls. Cron
  itself: use the provider's scheduler or `pg_cron` where offered, else a
  systemd timer / cloud scheduler hitting a function.

This is the single code change a managed-DB move forces. Everything else in
`public` is standard SQL.

---

## 7. Cutover checklist (zero-loss)

Do **not** flip a live app at the destination without a verified restore.

1. [ ] Target stack up; `prisma migrate deploy` applied; smoke test passes
       (`infra/self-host/README.md` § Smoke test).
2. [ ] Dry-run dump/restore into the target. Compare row counts (the restore
       script prints them) against the source for `auth.users`, `groups`,
       `expenses`, `settlements`. They must match.
3. [ ] `functions.env` filled; edge functions answer.
4. [ ] Storage: R2 reachable; any pre-R2 objects synced.
5. [ ] **Announce a short write freeze** (or accept a small replay window — the
       app's `clientMutationId` idempotency makes a re-sent write harmless).
6. [ ] Final delta: re-dump/restore, or replay the mutation queue.
7. [ ] Flip `EXPO_PUBLIC_SUPABASE_URL` + `ANON_KEY`; ship OTA (mobile) / redeploy
       (web).
8. [ ] Watch errors for a day. **Keep the Supabase project paused, not deleted**,
       until confident.

**Rollback:** because step 7 is just an env flip, reverting is flipping it back
and shipping again — provided you have not yet accepted new writes at the
destination. Once destination writes are live, roll-back means replaying those
back to Supabase, so keep the freeze window short and the destination watched.

---

## 8. Summary

- ~80% of Waves is plain Postgres + R2 — already portable.
- The escape-hatch stack (`infra/self-host/`) re-homes the other 20% with **no
  app change** and is worth standing up now as insurance.
- Data moves with `pg_dump` + `pg_restore`, UUIDs preserved.
- The only forced code change is `pg_net` → external worker, and only if you
  drop to a vanilla managed Postgres.
- Full native-cloud independence is real but should ride the ports/adapters
  seam, incrementally — never a big-bang rewrite.
