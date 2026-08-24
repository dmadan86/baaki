# Private / party-only attachments — built

Status: **built** (this PR). Implements the design + threat model in
[private-attachments-security-review.md](./private-attachments-security-review.md)
(§3 primitive; §4 settlement-proof UI is a thin follow-up on the same infra).
Validated on **local Postgres** only; not deployed (prod DB password stale, 28P01).

## What shipped

A visibility tier below the group: **`parties`**. Enforced at the DB (RLS) and
again at the presign (`r2-sign`), never in the client.

- **Two thin tables** — `settlement_proofs` (payment screenshot, visible to the
  settlement's from/to only) and `expense_attachments` (`group` = like a receipt;
  `parties` = the expense's payers + author). A restricted path is **never** a
  column on a group-visible row, so it cannot ship to non-parties through the
  pull or a direct PostgREST read.
- **Party predicates** `baaki_is_settlement_party` / `baaki_is_expense_party`
  (SECURITY DEFINER, answer only about the caller). SELECT policies embed them;
  writes are RPC-only so `uploader_member_id` is the session's, never a client
  argument.
- **`r2-sign` restricted branch** — reads are authorised by **subject + path**
  (the server confirms a party-visible row references that key, so a non-party is
  refused and a crafted path matches nothing), writes re-check party, URLs are
  **60 s** (an R2 presign cannot be revoked), and there is **no** Supabase-Storage
  dual-read fallback for these buckets.
- **Sync** — the two tables ride the pull **read as the caller**, so party RLS
  filters non-parties at the sync boundary; the mirror holds only a path, and the
  byte fetch is a second, re-checked gate. No restricted path is added to
  `SETTLEMENT_SELECT` / `EXPENSE_SELECT`.
- **Writes are a direct SECURITY DEFINER RPC** (the bytes need an online upload
  anyway), then a flush pulls the new row back — the add-person precedent
  (#194), not the offline queue.
- **UI** — a hidden/visible attachment section on the expense detail, with a
  visibility choice at add time and a lock badge on `parties` rows. The
  settlement-proof UI (§4) reuses the same hooks (see below).

## §4 settlement-proof UI — built (follow-up PR)

`SettlementProof` (`apps/mobile/src/components/SettlementProof.tsx`) — a single
party-only image on a settlement, wired into the group screen:

- **Payer side** — a new `pendingByMe` card on the group screen surfaces the
  payer's own recorded-but-unconfirmed settlements (which the app never
  acknowledged before). It carries "You paid {name}", "Waiting for {name} to
  confirm", and the attach/view/remove control (`canManage`).
- **Payee side** — the existing `pendingForMe` confirm card now shows the proof
  **view-only** above "Confirm received", so a confirmation answers evidence
  rather than a bare claim.
- **Ordering** — attach and remove are the same direct SECURITY DEFINER RPCs; a
  proof can only hang off a settlement that has already **synced** (its party
  check answers about a real row), so the control never appears mid-record. The
  proof image is picked with `pickAlbumPhoto` (EXIF-stripped re-encode) and
  resolved through the restricted `r2-sign` branch (60 s TTL, no dual-read).

## Threat tests

`packages/db/test/private-attachments.test.ts` — **T1–T14 green on local pg**:
non-party read → 0 rows; both parties → 1 each; group vs parties visibility;
former party who left → 0; anon → 0; outsider → 0; non-party attach denied;
direct write denied (uploader unforgeable); dropping a payer revokes access live;
key rotation on re-attach; `storage_objects` not client-readable; no `proof_path`
column on `settlements`.

## Deviations owed

- **ADR-006 (privacy)** — the `parties` sub-group visibility tier (extends the
  `TripMemberBudget` private/group precedent). Addendum required: the audience
  (settlement from/to; expense payers+author) and "enforcement is RLS + presign,
  never the client".
- **ADR-007 (settlement)** — a party-only, immutable image proof, evidence
  attached to (not a precondition of) confirmation. Addendum required.
- **ADR-011 / A44 (R2)** — two restricted buckets: short TTL + no dual-read
  fallback. One-line note.
- **Release gate** — not deployed. Needs `db:migrate deploy` (migration
  `20260824150000_private_attachments`) + `edge:deploy` (`sync` + `r2-sign`) in
  the same ops window as the album / category-budget work.
