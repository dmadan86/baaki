-- Let the client name the creator's membership id when it creates a group.
--
-- A group made offline needs its creator to be a member the moment it exists,
-- with an id the client already knows — otherwise a queued expense in that group
-- (an add-person IOU, TDR A34-style) cannot name who paid until the server has
-- assigned the membership and it has synced back. Until now baaki_create_group
-- minted the creator membership id itself, so those expenses had to be written
-- online by direct RPC (the A11/add-person deviation). This adds an optional
-- p_creator_member_id: when the client supplies it, the creator membership takes
-- that id (which the /sync queue and the mirror overlay both use); when it does
-- not, the server mints one exactly as before, so every existing caller — the
-- direct createGroup RPC, Splitwise import — is unaffected.
--
-- Adding a parameter changes the signature, which would leave two overloads if
-- done with CREATE OR REPLACE, so the old one is dropped first. Nothing depends
-- on it but callers (it is invoked by RPC), so the drop is clean.

DROP FUNCTION IF EXISTS public.baaki_create_group(
  text, text, character, text, boolean, uuid, text, char
);

CREATE FUNCTION public.baaki_create_group(
  p_name              text DEFAULT NULL::text,
  p_type              text DEFAULT 'other'::text,
  p_currency          character DEFAULT 'INR'::bpchar,
  p_emoji             text DEFAULT NULL::text,
  p_simplify          boolean DEFAULT true,
  p_group_id          uuid DEFAULT NULL::uuid,
  p_photo_path        text DEFAULT NULL::text,
  p_country           char(2) DEFAULT NULL,
  p_creator_member_id uuid DEFAULT NULL::uuid
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
  v_name       text := nullif(btrim(coalesce(p_name, '')), '');
  v_country    char(2) := nullif(btrim(upper(coalesce(p_country, ''))), '');
  v_is_guest   boolean;
  v_created_at timestamptz;
  v_group_count integer;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: a group needs an owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile_id) THEN
    RAISE EXCEPTION 'NO_PROFILE: profile % does not exist', v_profile_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Replaying the create half of a queue must return the same group, not a
  -- second one — and must not let somebody else's id be hijacked (ADR-005).
  -- This runs before the guest check on purpose: replaying the create of the
  -- one group a guest already has must not be mistaken for a second group.
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

  -- Guest ceilings (ADR-006 addendum). Mirrors GUEST_GROUP_LIMIT and
  -- GUEST_TRIAL_DAYS in @waves/core.
  --
  -- Guarded on the real auth.users *with* its `is_anonymous` column: CI runs
  -- these migrations against a stub auth schema whose users table has no such
  -- column, and calls this function to check ledger invariants. The column
  -- reference inside the branch is only planned when the branch actually runs
  -- (plpgsql plans statements lazily), so a false guard here means the missing
  -- column is never touched. Absent an is_anonymous column there are no
  -- anonymous users to limit anyway, so skipping the check is correct, not a
  -- hole.
  IF to_regclass('auth.users') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'auth'
         AND table_name = 'users'
         AND column_name = 'is_anonymous'
     ) THEN
    SELECT u.is_anonymous, u.created_at
      INTO v_is_guest, v_created_at
      FROM auth.users u
      WHERE u.id = v_profile_id;

    IF coalesce(v_is_guest, false) THEN
      IF now() >= v_created_at + interval '10 days' THEN
        RAISE EXCEPTION 'GUEST_TRIAL_EXPIRED: sign up to keep using Baaki'
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      SELECT count(*) INTO v_group_count
        FROM public.group_members
        WHERE profile_id = v_profile_id AND left_at IS NULL;

      IF v_group_count >= 1 THEN
        RAISE EXCEPTION 'GUEST_GROUP_LIMIT: sign up to be in more than one group'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.groups
    (id, name, type, default_currency, cover_emoji, simplify_debts, created_by, photo_path,
     country_code)
  VALUES
    (COALESCE(p_group_id, gen_random_uuid()), v_name, p_type::"GroupType",
     upper(p_currency), p_emoji, p_simplify, v_profile_id, p_photo_path,
     COALESCE(v_country, (SELECT country_code FROM public.profiles WHERE id = v_profile_id)))
  RETURNING id INTO v_group_id;

  -- The creator's membership takes the client's id when one was given, so a
  -- queued expense made in the same offline breath can already name it; else the
  -- server mints one as before.
  INSERT INTO public.group_members (id, group_id, profile_id, role, joined_via)
  VALUES (COALESCE(p_creator_member_id, gen_random_uuid()), v_group_id, v_profile_id, 'admin', 'creator')
  RETURNING id INTO v_member_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'created', 'group', v_group_id,
          jsonb_build_object('name', v_name));

  RETURN v_group_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_create_group(
  text, text, character, text, boolean, uuid, text, char, uuid
) TO authenticated, anon;
