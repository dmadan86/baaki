# Expense image audit (A46, part 2)

Who added or removed a receipt or an attachment on an expense, and when — the
image equivalent of the version history that already sits beside it. A bill's
photo is evidence for the amount; swapping or deleting it silently is a way to
change what an expense claims after the fact, and until now that left no trace.

## Why a new table, not `activity_log`

The group already has `activity_log`, and image events would fit its shape. But
`activity_log` is **group-visible** (`is_group_member` RLS), and an expense
attachment can be **party-only** (`visibility = 'parties'`, #407). Logging a
private attachment's add/remove into a group-visible feed would leak its very
existence to non-parties — the line "someone removed an attachment" is itself
the leak. So the audit lives in its own table whose SELECT policy embeds the
party predicate, exactly like the `expense_attachments` table it describes.

## Shape — `expense_image_events`

Migration `20260824180000_expense_image_events`. A group-scoped, mirror-backed,
**append-only** list (a correction is another line, never an erasure — so there
is no `deleted_at` tombstone here):

- `kind` `receipt | attachment`, `action` `added | removed`, `visibility`
  `group | parties` (mirrors the image's own visibility).
- `actor_member_id` — who did it, `SET NULL` if they later leave (shown as
  "someone").
- `updated_seq` + the shared `baaki_stamp_seq` trigger, so the `/sync` pull
  carries it like every other group table.
- RLS SELECT: `is_group_member(group_id) AND (visibility = 'group' OR
baaki_is_expense_party(expense_id))`. `REVOKE ALL … GRANT SELECT`; writes are
  RPC-only.

## Who writes a line

- **Attachments** — the existing `baaki_attach_expense_attachment` /
  `baaki_remove_expense_attachment` RPCs emit their own line inline, on the path
  that actually changed a row (an idempotent re-attach or a repeated remove does
  not stutter the trail). The event carries the attachment's own visibility, so
  a `parties` attachment's line is party-only too. Server-authoritative: a client
  cannot skip it.
- **The kept bill (E2)** has no DB row — its bytes go straight to R2 at
  `<groupId>/<expenseId>.jpg`. So the client calls `baaki_log_receipt_event`
  after a successful upload/remove. The door is receipt-only (kind hard-coded,
  visibility forced `group`), so it can never be used to fabricate a party-only
  attachment line. The actor is the session's; the event id is client-chosen so
  a retry is idempotent.

A missing audit line never blocks keeping or removing an image — the client
logs best-effort; the trail is evidence, not a gate.

## Client

- Read: `useExpenseImageEvents(expenseId)` off the mirror
  (`materialiseExpenseImageEvents`) → the "Image history" section on the expense
  detail, oldest first, a `Private` tag on a party-only line.
- The kept bill now has a **remove** control (trash) on its card, shown to a
  party or an admin; it deletes the R2 object and records the removal. Uploading
  again records an add — so "deleted then re-uploaded" reads as two lines.

## Scope

Expense images only — receipts and expense attachments. Settlement proofs are a
separate surface (settlement-scoped, shown on the settlement card) and already
carry `uploader_member_id`; they are out of this pass.

## Deviation

New capability, an extension of the A46 comments/audit work. Owed: a one-line
ADR-004/ADR-006 note that an expense's image changes are audited in a
party-aware, append-only table, and a TDR entry that `expense_image_events` is a
group-scoped, mirror-backed, RPC-only table.

## Release gate

Production needs the migration `20260824180000_expense_image_events` **and** the
updated `sync` edge function (it pulls the new table) before the mobile release,
or a client add/remove records nothing and the history shows blank. Same deploy
window as any migration + `edge:deploy`.
