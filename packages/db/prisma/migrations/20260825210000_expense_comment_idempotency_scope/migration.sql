-- baaki_add_expense_comment's idempotency replay was keyed on `p_comment_id`
-- alone: `SELECT id FROM expense_comments WHERE id = p_comment_id` then return
-- it if found, with no check that the row belongs to THIS group, THIS expense,
-- or the calling member. That makes a client-chosen id an existence oracle
-- across every group the caller happens to be a member of — reuse a
-- `p_comment_id` from group A while a member of group B and the call silently
-- "succeeds" (echoes A's id back) without inserting anything into B, which is
-- both a leak (does that id exist anywhere?) and a footgun (the caller believes
-- their comment was posted; it was not).
--
-- The sibling attach RPC (baaki_attach_expense_attachment, 20260824150000)
-- already scopes its own replay check to `id = p_attachment_id AND expense_id
-- = p_expense_id` — this brings the comment RPC in line with that precedent,
-- scoping to group + expense + author so a replay only ever matches the
-- caller's own prior write. A `p_comment_id` that collides with somebody
-- else's comment (or the caller's own comment on a different expense/group) is
-- now a conflict, not a silent echo.
--
-- Body-only change (CREATE OR REPLACE), no shape change — no Prisma drift.

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
  v_id            uuid;
  v_body          text := btrim(COALESCE(p_body, ''));
  v_me            uuid;
  v_existing_group    uuid;
  v_existing_expense  uuid;
  v_existing_author   uuid;
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

  v_me := public.baaki_my_member_id(p_group_id);

  -- Replaying a create must return the same row, not a second one (ADR-005) —
  -- but only when the id really is a replay of THIS caller's THIS write. A
  -- collision with an unrelated comment (another group, another expense,
  -- another author) is refused rather than echoed back.
  IF p_comment_id IS NOT NULL THEN
    SELECT id, group_id, expense_id, author_member_id
      INTO v_id, v_existing_group, v_existing_expense, v_existing_author
      FROM public.expense_comments
     WHERE id = p_comment_id;
    IF v_id IS NOT NULL THEN
      IF v_existing_group = p_group_id
         AND v_existing_expense = p_expense_id
         AND v_existing_author IS NOT DISTINCT FROM v_me
      THEN
        RETURN v_id;
      END IF;
      RAISE EXCEPTION 'COMMENT_ID_CONFLICT: that id belongs to a different comment'
        USING ERRCODE = 'unique_violation';
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
    (COALESCE(p_comment_id, gen_random_uuid()), p_group_id, p_expense_id, v_me, v_body)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_add_expense_comment(uuid, uuid, uuid, text)
  TO authenticated, anon;
