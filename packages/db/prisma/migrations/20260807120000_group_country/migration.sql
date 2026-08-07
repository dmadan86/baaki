-- Letting a group say where it is.
--
-- The previous migration gave `groups` a `country_code` and the settle screen
-- reads it, but nothing could ever write one: `baaki_create_group` had no
-- parameter for it and every group came out NULL. Plumbing without a tap.
--
-- The body below is the deployed function verbatim — read back out of the live
-- database with `pg_get_functiondef` rather than reconstructed from an earlier
-- migration, because this function has been replaced twice and the version in
-- `20260805050000_m2_offline_sync` is two revisions stale. (Rebuilding
-- `baaki_record_settlement` from memory a migration ago dropped its client
-- mutation id, which would have let a retried settlement pay somebody twice.
-- Reading the real one first is cheap; the alternative is not.)
--
-- One parameter added, with a default, so every existing caller is unaffected.
--
-- The DROP first is not optional. `CREATE OR REPLACE` only replaces a function
-- of the *same* arity — add a parameter and Postgres keeps both, and then a
-- seven-argument call matches neither uniquely: `function baaki_create_group(
-- unknown, unknown, unknown, unknown, boolean, unknown, unknown) is not
-- unique`. Every existing caller breaks, having changed nothing.

DROP FUNCTION IF EXISTS public.baaki_create_group(
  text, text, character, text, boolean, uuid, text
);

CREATE OR REPLACE FUNCTION public.baaki_create_group(
  p_name       text DEFAULT NULL::text,
  p_type       text DEFAULT 'other'::text,
  p_currency   character DEFAULT 'INR'::bpchar,
  p_emoji      text DEFAULT NULL::text,
  p_simplify   boolean DEFAULT true,
  p_group_id   uuid DEFAULT NULL::uuid,
  p_photo_path text DEFAULT NULL::text,
  /**
   * ISO-3166 alpha-2 — where this group settles, which decides which payment
   * rails it is offered. NULL is a supported answer: a group that never says
   * falls back to bank, cash and the cross-border wallets, which is what
   * `railsFor(null)` returns.
   */
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

  INSERT INTO public.groups
    (id, name, type, default_currency, cover_emoji, simplify_debts, created_by, photo_path,
     country_code)
  VALUES
    (COALESCE(p_group_id, gen_random_uuid()), v_name, p_type::"GroupType",
     upper(p_currency), p_emoji, p_simplify, v_profile_id, p_photo_path,
     -- Falls back to the creator's own country, because a person making a
     -- group is almost always making it where they are. Still NULL if they
     -- have never said either.
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

-- A country is two letters or it is nothing. Cheap, and it stops a locale tag
-- ('en-AE') or a full country name being written where a code belongs.
ALTER TABLE public.groups
  DROP CONSTRAINT IF EXISTS groups_country_code_shape;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_country_code_shape CHECK (
    country_code IS NULL OR country_code ~ '^[A-Z]{2}$'
  );

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_country_code_shape;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_country_code_shape CHECK (
    country_code IS NULL OR country_code ~ '^[A-Z]{2}$'
  );
