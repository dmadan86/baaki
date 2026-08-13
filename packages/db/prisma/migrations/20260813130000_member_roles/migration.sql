-- An admin can make another member an admin (and take it back).
--
-- Until now the product changed nobody's role. The security hardening in
-- 20260807090000 pinned that shut with a trigger — `baaki_guard_membership_columns`
-- raises on any client UPDATE that moves `role`, because at the time the only
-- way a role could change was a member promoting themselves, and that is an
-- attack, not a feature.
--
-- The feature is different: an *existing admin* promoting *somebody else*. The
-- trigger already allows exactly this shape — it lets the change through when
-- `current_user` is not a signed-in client, and a SECURITY DEFINER function runs
-- as its owner. So the door is this one RPC, gated on `is_group_admin`, and the
-- trigger stays shut against everything else. Nothing about the self-promotion
-- block is loosened.
--
-- Two rules the RPC keeps that the raw column never could:
--   * A ghost cannot be an admin. A ghost is a name with no login; making it an
--     admin would create authority nobody can exercise.
--   * A group never loses its last admin. Demoting the only one is refused, so a
--     group cannot be orphaned into a state where no one can promote anybody.

CREATE OR REPLACE FUNCTION public.baaki_set_member_role(
  p_member_id uuid,
  p_role      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id   uuid;
  v_profile_id uuid;
  v_old_role   public."MemberRole";
  v_admins     int;
BEGIN
  SELECT group_id, profile_id, role
    INTO v_group_id, v_profile_id, v_old_role
  FROM public.group_members WHERE id = p_member_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such member' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.is_group_admin(v_group_id) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN: only an admin changes another member''s role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'INVALID_ROLE: admin or member' USING ERRCODE = 'check_violation';
  END IF;

  -- A ghost has no login; an admin ghost is authority nobody holds.
  IF p_role = 'admin' AND v_profile_id IS NULL THEN
    RAISE EXCEPTION 'GHOST_CANNOT_ADMIN: a ghost has no account to act with'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Never demote the last admin — a group with no admin can promote nobody.
  IF p_role = 'member' AND v_old_role = 'admin' THEN
    SELECT count(*) INTO v_admins
    FROM public.group_members
    WHERE group_id = v_group_id AND role = 'admin' AND left_at IS NULL;
    IF v_admins <= 1 THEN
      RAISE EXCEPTION 'LAST_ADMIN: a group keeps at least one admin'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE public.group_members
     SET role = p_role::public."MemberRole",
         updated_at = now()
   WHERE id = p_member_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_set_member_role(uuid, text) TO authenticated, anon;
