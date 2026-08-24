# Trip album — the third photo concept

Status: **built** (this PR). A formal addendum to `baaki-adr.md` is owed — see
_Deviation_ below.

## Why a new table, not another column

The app already had two photo concepts, and the album is neither:

| Concept         | Where it lives              | How many        | Who / cost                                       | Browsed as                           |
| --------------- | --------------------------- | --------------- | ------------------------------------------------ | ------------------------------------ |
| Group **cover** | `groups.photo_path`         | one per group   | admin, **paid** (`baaki_can_upload_group_photo`) | the group's identity                 |
| **Receipt**     | `receipts` bucket + expense | one per expense | any member, evidence of a bill                   | a full-screen viewer, for the amount |
| **Album** photo | `trip_photos` (new)         | many per trip   | any member, **free**                             | a grid / a strip, for the memory     |

Folding the album into either of the other two would break something concrete:
a receipt is one-per-expense and read by OCR; a cover is one-per-group and paid.
The album is many, free, and optionally pinned to an expense **or** just a day.
So it is its own table.

## Shape

`trip_photos` mirrors `trip_plan_items` exactly, because it is the same kind of
thing — a group's shared, non-money list that must work offline:

- **Not money.** It moves no balance, touches no split, appears in no export.
- **Offline-first (ADR-005).** `updated_seq` + the shared `baaki_stamp_seq`
  trigger, so the `/sync` pull carries it; a removal is a soft-delete
  `deleted_at` tombstone (a hard `DELETE` never reaches a seq-based pull), which
  the client mirror filters out.
- **RPC-only writes.** `REVOKE ALL … GRANT SELECT`; `baaki_add_trip_photo` /
  `baaki_remove_trip_photo` are the only way in, so `created_by` comes from the
  session, not a client argument, and an expense link is validated against the
  same group (no pinning to a stranger's bill).

## Storage & privacy

- Bytes go to Cloudflare R2 under a new logical bucket `trip-photos`, brokered by
  `r2-sign` (the client holds no R2 key). A `get`/`put` is authorised by group
  membership — **no paid gate**, unlike the cover. Album photos count against the
  free-tier storage cap exactly like a receipt (`baaki_storage_reserve/record`).
- **EXIF is stripped on device.** The photo is re-encoded (WebP, JPEG fallback)
  before upload, which drops GPS/orientation metadata — a beach photo must not
  carry the place it was taken into a shared album.
- A removal soft-deletes the row (tombstone) and, best-effort while online, frees
  the R2 bytes through `r2-sign`; the storage sweep is the backstop offline.

## Deviation

New capability, not in the current TDR/ADR. Owed: a short addendum to
`baaki-adr.md` recording the three-photo-concepts split and the album's
free/membership-only storage rule, and a TDR note that `trip_photos` is a
group-scoped, mirror-backed, non-money table.

**Release gate.** The mobile album UI uploads to `trip-photos` and queues
`trip_photo.add`/`trip_photo.delete`; production must have the migration
`20260824140000_trip_album` **and** the updated `sync` + `r2-sign` functions
first, or a client add fails to record and a browse shows nothing. Not deployed
(prod DB password is stale, 28P01): gate the mobile release on a successful
`pnpm db:migrate` + `pnpm edge:deploy`, the same window the category-budgets
work needs.
