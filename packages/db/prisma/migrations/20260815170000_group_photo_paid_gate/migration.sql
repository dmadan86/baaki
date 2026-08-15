-- Group photos are a paid feature; icons (cover emoji) stay free for everyone.
--
-- The rule the app asks for: a group may carry a real photo if *anyone* in it is
-- paid — one member's subscription lifts the whole group, so a paid person can
-- set the picture for the trip everyone else is on for free. A brand-new group
-- has only its creator, so there the question reduces to "is the creator paid".
--
-- This has to be answered server-side. A member cannot read another member's
-- subscriptions under RLS (nor should they), so "is anyone here paid" is a
-- SECURITY DEFINER question. These functions expose only a single boolean —
-- never whose subscription it was, or anything else about it.

-- Is this one profile paid right now: an active subscription that has not lapsed
-- (a lifetime purchase has no period end and never lapses).
CREATE OR REPLACE FUNCTION public.baaki_profile_is_paid(p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.subscriptions s
     WHERE s.profile_id = p_profile
       AND s.status = 'active'
       AND (s.current_period_end IS NULL OR s.current_period_end > now())
  );
$$;

REVOKE ALL ON FUNCTION public.baaki_profile_is_paid(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_profile_is_paid(uuid) TO authenticated, anon;

-- May the caller set a real photo on this group (or, with no group yet, on a
-- group they are about to create)?
--   * no group id  → a new group; only the creator exists, so gate on the
--     caller's own subscription;
--   * a group id   → true if any current member is paid, or the group itself
--     holds an unexpired pass. The caller must be a member to ask.
-- Returns a bare boolean; the client uses it to choose the photo picker or the
-- icon-only path, and the storage RLS still guards the upload itself.
CREATE OR REPLACE FUNCTION public.baaki_can_upload_group_photo(p_group_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
BEGIN
  IF v_profile IS NULL THEN
    RETURN false;
  END IF;

  IF p_group_id IS NULL THEN
    RETURN public.baaki_profile_is_paid(v_profile);
  END IF;

  -- Only a member may ask about their group.
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.profile_id = v_profile
       AND gm.left_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.left_at IS NULL
       AND gm.profile_id IS NOT NULL
       AND public.baaki_profile_is_paid(gm.profile_id)
  ) OR EXISTS (
    SELECT 1 FROM public.group_passes gp
     WHERE gp.group_id = p_group_id
       AND gp.expires_at > now()
  );
END
$$;

REVOKE ALL ON FUNCTION public.baaki_can_upload_group_photo(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_can_upload_group_photo(uuid) TO authenticated, anon;
