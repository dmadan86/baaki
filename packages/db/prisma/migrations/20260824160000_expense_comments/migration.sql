-- Per-expense comments: a thread on one bill that every group member can read
-- and add to, so a "what was this for?" lives next to the expense instead of in
-- a chat app nobody can find later.
--
-- Like the trip album (20260824140000) and the plan, this is a group's shared
-- list, not money: it moves nobody's balance and never touches a split. So it
-- rides the same offline mirror — an `updated_seq` the /sync pull walks, stamped
-- by the shared `baaki_stamp_seq` trigger, and a soft-delete `deleted_at` so a
-- removal reaches a second device as a tombstone (a hard DELETE never reaches a
-- seq-based pull). The bytes are just text; there is no R2 object.
--
-- The permission matrix is the whole reason writes go through RPCs rather than a
-- table grant (a client that writes the row would pick its own author):
--   * any member  — add a comment; edit and delete their OWN; flag/report any;
--   * an admin     — additionally delete ANY comment; clear a flag (resolve);
--   * a non-admin  — may NOT delete or edit someone else's comment.
-- Enforced here with `baaki_my_member_id` (author identity the caller cannot
-- forge) and `is_group_admin` (the same predicate the role screens use).

CREATE TABLE IF NOT EXISTS public.expense_comments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
  expense_id       uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  /** Who wrote it. SET NULL if that membership is later removed — the comment
      survives the person leaving, shown as "someone". */
  author_member_id uuid REFERENCES public.group_members(id) ON DELETE SET NULL ON UPDATE CASCADE,
  body             text NOT NULL,
  /** When the author last edited it, NULL if never — the UI shows "edited". */
  edited_at        timestamptz,
  /** A report: when it was flagged and by whom, NULL if not flagged. Any member
      may set it; an admin clears it (resolves). */
  flagged_at       timestamptz,
  flagged_by       uuid REFERENCES public.group_members(id) ON DELETE SET NULL ON UPDATE CASCADE,
  /** Soft-delete tombstone + who removed it (the author, or an admin removing
      someone else's). SET NULL keeps the tombstone if that membership is gone. */
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES public.group_members(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Sync plumbing (ADR-005), identical to trip_photos / trip_plan_items.
  updated_seq      bigint NOT NULL DEFAULT 0,

  CONSTRAINT expense_comments_body_present CHECK (btrim(body) <> ''),
  CONSTRAINT expense_comments_body_sane CHECK (char_length(body) <= 2000)
);

CREATE INDEX IF NOT EXISTS expense_comments_group_id_updated_seq_idx
  ON public.expense_comments (group_id, updated_seq);
-- The expense-detail thread reads by expense, oldest first.
CREATE INDEX IF NOT EXISTS expense_comments_expense_idx
  ON public.expense_comments (expense_id, created_at);

DROP TRIGGER IF EXISTS expense_comments_stamp_seq ON public.expense_comments;
CREATE TRIGGER expense_comments_stamp_seq
  BEFORE INSERT OR UPDATE ON public.expense_comments
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

ALTER TABLE public.expense_comments ENABLE ROW LEVEL SECURITY;

-- Everybody in the group sees the thread; a comment is a group-visible signal
-- (unlike a party-only attachment). Deleted rows still match — they ride the
-- pull as tombstones — but the client filters them out of the rendered list.
CREATE POLICY expense_comments_select ON public.expense_comments
  FOR SELECT TO anon, authenticated
  USING (public.is_group_member(group_id));

-- No INSERT/UPDATE/DELETE policy and no privilege: the RPCs below are the only
-- way in, so author_member_id is the session's and the role matrix cannot be
-- bypassed with a direct PostgREST write.
REVOKE ALL ON public.expense_comments FROM anon, authenticated;
GRANT SELECT ON public.expense_comments TO anon, authenticated;

-- ────────────────────────────────────────────────────────────── writing ──

/**
 * Add a comment. Membership is enough — any member may speak. `p_comment_id` is
 * client-chosen and the idempotency key: replaying a create returns the same row
 * rather than a duplicate, which a phone on flaky signal will do. The expense
 * must be in THIS group, or a comment could pin to a stranger's bill.
 */
CREATE OR REPLACE FUNCTION public.baaki_add_expense_comment(
  p_group_id   uuid,
  p_expense_id uuid,
  p_comment_id uuid,
  p_body       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id   uuid;
  v_body text := btrim(COALESCE(p_body, ''));
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_body = '' THEN
    RAISE EXCEPTION 'EMPTY_COMMENT: a comment needs some text'
      USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'COMMENT_TOO_LONG: keep it under 2000 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying a create must return the same row, not a second one (ADR-005).
  IF p_comment_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.expense_comments WHERE id = p_comment_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expenses WHERE id = p_expense_id AND group_id = p_group_id
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_EXPENSE: that expense is not in this group'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.expense_comments
    (id, group_id, expense_id, author_member_id, body)
  VALUES
    (COALESCE(p_comment_id, gen_random_uuid()), p_group_id, p_expense_id,
     public.baaki_my_member_id(p_group_id), v_body)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_add_expense_comment(uuid, uuid, uuid, text)
  TO authenticated, anon;

/**
 * Edit a comment. Only its author — editing someone else's words is not a thing
 * even an admin does; an admin's lever is removal, not rewriting. Stamps
 * `edited_at` so the UI can be honest that the text changed.
 */
CREATE OR REPLACE FUNCTION public.baaki_edit_expense_comment(
  p_comment_id uuid,
  p_body       text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_author   uuid;
  v_body     text := btrim(COALESCE(p_body, ''));
BEGIN
  SELECT group_id, author_member_id INTO v_group_id, v_author
    FROM public.expense_comments
   WHERE id = p_comment_id AND deleted_at IS NULL;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_COMMENT: no such comment'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_author IS NULL OR v_author <> public.baaki_my_member_id(v_group_id) THEN
    RAISE EXCEPTION 'NOT_YOUR_COMMENT: you can only edit your own'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_body = '' THEN
    RAISE EXCEPTION 'EMPTY_COMMENT: a comment needs some text'
      USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'COMMENT_TOO_LONG: keep it under 2000 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.expense_comments
     SET body = v_body, edited_at = now()
   WHERE id = p_comment_id AND deleted_at IS NULL;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_edit_expense_comment(uuid, text)
  TO authenticated, anon;

/**
 * Delete a comment. The author may delete their own; an admin may delete ANY (a
 * moderation lever). A non-admin deleting someone else's is refused — the one
 * asymmetry the whole feature turns on. Soft delete + `deleted_by` so the
 * tombstone rides the pull and records who pruned it.
 */
CREATE OR REPLACE FUNCTION public.baaki_delete_expense_comment(p_comment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_author   uuid;
  v_me       uuid;
BEGIN
  SELECT group_id, author_member_id INTO v_group_id, v_author
    FROM public.expense_comments WHERE id = p_comment_id;
  IF v_group_id IS NULL THEN
    RETURN; -- Never existed. Removing nothing is not an error.
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_me := public.baaki_my_member_id(v_group_id);
  -- Own comment, or an admin reaching for anyone's. Nothing else.
  IF NOT (v_author = v_me OR public.is_group_admin(v_group_id)) THEN
    RAISE EXCEPTION 'CANNOT_DELETE: only the author or an admin can delete this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_comments
     SET deleted_at = now(), deleted_by = v_me
   WHERE id = p_comment_id AND deleted_at IS NULL;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_delete_expense_comment(uuid)
  TO authenticated, anon;

/**
 * Flag or unflag a comment. Flagging is a report any member can raise — "an
 * admin should look at this". Clearing a flag is an admin's call (resolving the
 * report), so a member cannot quietly un-report their own comment after someone
 * flags it. The first flagger is kept; re-flagging an already-flagged comment is
 * a no-op rather than a way to erase who reported it.
 */
CREATE OR REPLACE FUNCTION public.baaki_flag_expense_comment(
  p_comment_id uuid,
  p_flag       boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id
    FROM public.expense_comments WHERE id = p_comment_id AND deleted_at IS NULL;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_COMMENT: no such comment'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_flag THEN
    -- Any member reports; keep the first flagger (WHERE flagged_at IS NULL).
    UPDATE public.expense_comments
       SET flagged_at = now(), flagged_by = public.baaki_my_member_id(v_group_id)
     WHERE id = p_comment_id AND deleted_at IS NULL AND flagged_at IS NULL;
  ELSE
    -- Only an admin resolves a report.
    IF NOT public.is_group_admin(v_group_id) THEN
      RAISE EXCEPTION 'ADMIN_ONLY: only an admin can clear a flag'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE public.expense_comments
       SET flagged_at = NULL, flagged_by = NULL
     WHERE id = p_comment_id AND deleted_at IS NULL;
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_flag_expense_comment(uuid, boolean)
  TO authenticated, anon;
