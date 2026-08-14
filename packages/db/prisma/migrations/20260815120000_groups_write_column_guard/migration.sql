-- Pinning the columns of `public.groups` a client may never write.
--
-- The 2026-08-07 hardening revoked direct client writes on the ledger tables
-- and column-guarded `group_members`, but `groups` was missed: it still carries
-- the broad `groups_update` RLS policy (row-scoped by `is_group_member(id)`,
-- 20260804163800) with no column guard. `/sync` narrows a `group.update` to a
-- whitelist (`GROUP_UPDATABLE_FIELDS`), but that whitelist lives in the edge
-- function — a member can bypass it entirely with a direct
-- `PATCH /groups?id=eq.<X>` under their own JWT and set ANY column.
--
-- The dangerous one is `updated_seq`. It is the pull high-water mark every
-- member's sync compares against (`gt('updated_seq', since)`); the
-- `groups_stamp_seq` BEFORE-UPDATE trigger only auto-bumps it when the client
-- did NOT supply a value, so a client-supplied `updated_seq` passes straight
-- through. Poisoning it to a large number makes every member's cursor jump past
-- it, after which all real future changes are silently skipped — group-wide
-- ledger divergence, no error anywhere.
--
-- Same shape as `baaki_guard_membership_columns`: a BEFORE-UPDATE trigger that
-- lets service-role / SECURITY DEFINER / migration paths through untouched and
-- forbids a signed-in client from moving the structural columns. The whitelist
-- fields (name, currency, reminders, …) are untouched, so both `/sync` (which
-- runs as the caller) and any legitimate direct field edit keep working.
--
-- Trigger fire order matters: BEFORE triggers run alphabetically by name, so
-- `groups_guard_columns` fires before `groups_stamp_seq`. On a legitimate edit
-- the client never sends `updated_seq`, the guard sees no change and returns,
-- and the stamp trigger then bumps it as before.

CREATE OR REPLACE FUNCTION public.baaki_guard_group_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Service-role jobs, SECURITY DEFINER functions (run as owner) and migrations
  -- are the only paths that legitimately touch these columns. A signed-in
  -- client — `anon` or `authenticated` — is never one of them.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- The sync high-water mark. Only `groups_stamp_seq` (a trigger, owner-run)
  -- may advance it; a client that sets it can desync the whole group.
  IF NEW.updated_seq IS DISTINCT FROM OLD.updated_seq THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: updated_seq is set by the server, not the client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Provenance and identity are fixed at creation.
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s creator is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s id is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s creation time is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS groups_guard_columns ON public.groups;
CREATE TRIGGER groups_guard_columns
  BEFORE UPDATE ON public.groups
  FOR EACH ROW EXECUTE FUNCTION public.baaki_guard_group_columns();
