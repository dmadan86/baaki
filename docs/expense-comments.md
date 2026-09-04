# Expense comments — built

Status: **built** (this PR). Validated on **local Postgres** (16 threat tests);
not deployed until an ops window (migration + `sync` edge redeploy).

A group-visible comment thread on one expense — a "what was this for?" that lives
next to the bill instead of in a chat app. Text only; no bytes, no R2.

## Permission matrix (enforced in the RPCs, never the client)

| Action        | Member | Author (own) | Admin           |
| ------------- | ------ | ------------ | --------------- |
| view / add    | ✅     | ✅           | ✅              |
| edit          | —      | ✅ own       | — (not others') |
| delete        | —      | ✅ own       | ✅ any          |
| flag / report | ✅ any | —            | ✅ any          |
| clear a flag  | —      | —            | ✅ only         |

The one asymmetry the feature turns on: **a non-admin can never edit or delete
someone else's comment.** Editing is author-only even for an admin — an admin's
lever is removal, not rewriting words. Flagging is a report any member can raise;
only an admin resolves it (so a member cannot quietly un-report their own comment
after it is flagged). The first flagger is kept; re-flagging is a no-op.

## Shape

- **Table** `expense_comments` (migration `20260824160000_expense_comments`) —
  `author_member_id` (who, from the session), `body`, `edited_at`, `flagged_at`/
  `flagged_by`, `deleted_at`/`deleted_by` (soft-delete tombstone), `updated_seq`.
  RLS SELECT `is_group_member`; `REVOKE ALL` + `GRANT SELECT`; writes RPC-only.
- **RPCs** (SECURITY DEFINER): `waves_add_expense_comment` (idempotent on a
  client id, expense-in-group check), `waves_edit_expense_comment` (author only,
  stamps `edited_at`), `waves_delete_expense_comment` (author or `is_group_admin`,
  soft-delete + `deleted_by`), `waves_flag_expense_comment(id, flag)` (set = any
  member, clear = admin).
- **Sync** — rides the offline mirror pull like `trip_photos`/attachments: a new
  `SyncTable.ExpenseComments`, a `materialiseExpenseComments` (oldest-first,
  filters tombstones), the `['expense_comments','*']` pull entry (read as the
  caller, so `is_group_member` filters at the boundary). Writes are **direct**
  SECURITY DEFINER RPCs (not the queue) so the role matrix is server-checked.
- **UI** — `ExpenseComments` on the expense detail, below History: a composer,
  the thread, and per-comment controls that mirror exactly what the RPCs allow
  (edit/delete for the author, delete/resolve for an admin, report for others).
  i18n `comments` group ×4 (en/ta/hi/ar).

## Threat tests

`packages/db/test/expense-comments.test.ts` — **T1–T16 green on local pg**:
member add + all-members read; non-member add denied + read 0; anon denied;
author edits own (edited_at); non-author (incl. admin) cannot edit; author
deletes own; non-admin cannot delete others'; admin deletes any (+ deleted_by);
any member flags (first flagger kept); non-admin cannot clear a flag; admin
resolves; idempotent re-add; cross-group expense refused; empty body refused;
the table is not directly writable (INSERT/UPDATE/DELETE by a member denied).

## Deviations owed

- **TDR / ADR-006** — a new group-visible per-expense thread. A short amendment:
  comments are group-visible (not party-tiered), moderation is `admin`-gated via
  the existing `is_group_admin`, and reporting is any-member.
- **Release gate** — not deployed. Needs `db:migrate deploy` (migration
  `20260824160000`) + `edge:deploy` (`sync`).
