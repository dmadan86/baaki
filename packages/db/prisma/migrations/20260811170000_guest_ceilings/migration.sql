-- The two ceilings on a guest (ADR-006 addendum): one group, ten days.
--
-- ADR-006 lets anybody start with no account and keeps their data when they
-- upgrade in place. This does not undo that — nothing here deletes a row or
-- moves it to another account. It adds a limit: an anonymous account may be in
-- exactly one group, and may keep writing for ten days from when it was made,
-- after which it is read-only until a real identity is attached.
--
-- The app enforces both in the UI (guestGate() in @baaki/core), but the app is
-- not the only way in: a client that skips the guard and calls this function
-- directly must still be refused. So group creation — the tap, and the offline
-- `group.create` the sync function routes back through here — checks the same
-- two numbers server-side. The read-only half (expenses, settlements) is held
-- in the sync function, which is the one door those writes come through.
--
-- The numbers are literals here because a SQL function cannot import the TS
-- constants. They mirror GUEST_GROUP_LIMIT (1) and GUEST_TRIAL_DAYS (10); the
-- comment in guestLimits.ts points back the other way so a change to one is a
-- prompt to change the other.
--
-- The whole function is re-read from the live database (as the previous
-- revision was) and reprinted with one guard block added, because CREATE OR
-- REPLACE cannot change a body without restating all of it, and a DROP is not
-- needed when the signature is unchanged.

CREATE OR REPLACE FUNCTION public.baaki_create_group(
  p_name       text DEFAULT NULL::text,
  p_type       text DEFAULT 'other'::text,
  p_currency   character DEFAULT 'INR'::bpchar,
  p_emoji      text DEFAULT NULL::text,
  p_simplify   boolean DEFAULT true,
  p_group_id   uuid DEFAULT NULL::uuid,
  p_photo_path text DEFAULT NULL::text,
  p_country    char(2) DEFAULT NULL
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
  -- GUEST_TRIAL_DAYS in @baaki/core.
  --
  -- Guarded on `auth.users` existing, exactly as the admin reports are: CI runs
  -- these migrations against bare Postgres with no auth schema, and calls this
  -- function to check ledger invariants. Without the guard that call would fail
  -- on a missing table. Absent auth.users, there are no anonymous users to
  -- limit, so skipping the check is the correct behaviour there, not a hole.
  IF to_regclass('auth.users') IS NOT NULL THEN
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

  INSERT INTO public.group_members (group_id, profile_id, role, joined_via)
  VALUES (v_group_id, v_profile_id, 'admin', 'creator')
  RETURNING id INTO v_member_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'created', 'group', v_group_id,
          jsonb_build_object('name', v_name));

  RETURN v_group_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_create_group(
  text, text, character, text, boolean, uuid, text, char
) TO authenticated, anon;
