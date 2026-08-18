-- A capture can now carry two hints that survive until it is assigned:
--   payment_method  — how the spend was paid (cash / credit / debit / forex),
--                     a free-text tag the UI constrains to a known set.
--   target_group_id — the group the owner intends this for, chosen up front but
--                     NOT yet assigned. Advisory, exactly like assigned_group_id:
--                     the target lives in a different (group) scope, so no FK —
--                     the split and the real expense are still decided later.
ALTER TABLE "public"."captures"
  ADD COLUMN "payment_method" text,
  ADD COLUMN "target_group_id" uuid;
