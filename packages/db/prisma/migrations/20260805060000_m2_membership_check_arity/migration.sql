-- Fix for 20260805050000_m2_offline_sync.
--
-- `baaki_create_group` and `baaki_add_ghost_member` called
-- `is_group_member(group_id, profile_id)`, but that function takes one argument
-- and reads the caller from `request.jwt.claims` itself — so both raised
-- `function public.is_group_member(uuid, uuid) does not exist` and neither
-- offline-created groups nor offline-added ghosts could ever sync.
--
-- Postgres resolves function calls at execution time, not at CREATE FUNCTION
-- time, so nothing complained until the M2 suite ran it.

CREATE OR REPLACE FUNCTION public.baaki_create_group(
  p_name text,
  p_type text DEFAULT 'other',
  p_currency char(3) DEFAULT 'INR',
  p_emoji text DEFAULT NULL,
  p_simplify boolean DEFAULT true,
  p_group_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_id uuid := public.baaki_current_profile_id();
  v_group_id   uuid;
  v_member_id  uuid;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: a group needs an owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile_id) THEN
    RAISE EXCEPTION 'NO_PROFILE: profile % does not exist', v_profile_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF coalesce(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'INVALID_NAME: a group needs a name' USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying the create half of a queue must return the same group, not a
  -- second one — and must not let somebody else's id be hijacked.
  IF p_group_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.groups WHERE id = p_group_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = p_group_id AND gm.profile_id = v_profile_id AND gm.left_at IS NULL
    ) THEN
      RAISE EXCEPTION 'GROUP_EXISTS: that group id is already taken'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN p_group_id;
  END IF;

  INSERT INTO public.groups (id, name, type, default_currency, cover_emoji, simplify_debts, created_by)
  VALUES (COALESCE(p_group_id, gen_random_uuid()), trim(p_name), p_type::"GroupType",
          upper(p_currency), p_emoji, p_simplify, v_profile_id)
  RETURNING id INTO v_group_id;

  INSERT INTO public.group_members (group_id, profile_id, role, joined_via)
  VALUES (v_group_id, v_profile_id, 'admin', 'creator')
  RETURNING id INTO v_member_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'created', 'group', v_group_id,
          jsonb_build_object('name', trim(p_name)));

  RETURN v_group_id;
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_add_ghost_member(
  p_group_id  uuid,
  p_name      text,
  p_member_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_id uuid := public.baaki_current_profile_id();
  v_member_id  uuid;
BEGIN
  IF v_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.profile_id = v_profile_id AND gm.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'INVALID_NAME: a ghost needs a name' USING ERRCODE = 'check_violation';
  END IF;

  IF p_member_id IS NOT NULL THEN
    SELECT id INTO v_member_id FROM public.group_members
     WHERE id = p_member_id AND group_id = p_group_id;
    IF FOUND THEN
      RETURN v_member_id;  -- replay
    END IF;
  END IF;

  INSERT INTO public.group_members (id, group_id, ghost_name, joined_via)
  VALUES (COALESCE(p_member_id, gen_random_uuid()), p_group_id, trim(p_name), 'ghost')
  RETURNING id INTO v_member_id;

  RETURN v_member_id;
END
$$;
