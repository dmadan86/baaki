-- Groups without a name, and a photo instead of an emoji (ADR-006).
--
-- Starting a group should cost one tap. Demanding a name first is a form to
-- fill in before the app does anything useful, and the name is the least
-- important thing about "me, Priya and Ravi in Goa" — the people are the
-- group. So the name becomes optional and the app labels an unnamed group by
-- who is in it.

-- ────────────────────────────────────────────── 1. an optional name ──
-- NULL rather than '' on purpose. An empty string is a value that sorts,
-- exports and compares like a name while meaning "no name", and every place
-- that reads it has to remember that. NULL says it once.

ALTER TABLE public.groups ALTER COLUMN name DROP NOT NULL;

UPDATE public.groups SET name = NULL WHERE btrim(name) = '';

ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_name_not_blank;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_name_not_blank
  CHECK (name IS NULL OR btrim(name) <> '');

-- The photo lives in Storage; this is the object path inside the bucket.
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS photo_path text;

-- `baaki_create_group` refused a blank name. Now it accepts one and stores
-- NULL, and takes the photo path so a group created in one round trip can
-- already have its picture.
--
-- Dropped rather than replaced: adding a parameter changes the signature, and
-- Postgres treats a different argument list as a different function. CREATE OR
-- REPLACE would leave both in place, and every existing five- or six-argument
-- call would then fail with "function baaki_create_group(...) is not unique".
DROP FUNCTION IF EXISTS public.baaki_create_group(text, text, char, text, boolean, uuid);
DROP FUNCTION IF EXISTS public.baaki_create_group(text, text, char, text, boolean);

CREATE OR REPLACE FUNCTION public.baaki_create_group(
  p_name text DEFAULT NULL,
  p_type text DEFAULT 'other',
  p_currency char(3) DEFAULT 'INR',
  p_emoji text DEFAULT NULL,
  p_simplify boolean DEFAULT true,
  p_group_id uuid DEFAULT NULL,
  p_photo_path text DEFAULT NULL
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
    (id, name, type, default_currency, cover_emoji, simplify_debts, created_by, photo_path)
  VALUES
    (COALESCE(p_group_id, gen_random_uuid()), v_name, p_type::"GroupType",
     upper(p_currency), p_emoji, p_simplify, v_profile_id, p_photo_path)
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

-- ─────────────────────────────────────────── 2. the photo bucket ──
-- Everything below touches the `storage` schema, which belongs to Supabase and
-- does not exist in the plain Postgres image CI runs migrations against. The
-- guard is what keeps `prisma migrate deploy` working in both places; without
-- it the whole migration fails in CI on a missing relation.

CREATE OR REPLACE FUNCTION public.baaki_group_from_storage_path(p_path text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  -- Objects are stored as "<group id>/cover.jpg". Anything that is not a UUID
  -- in the first segment returns NULL, which fails every policy below rather
  -- than raising — a malformed path is a denial, not an error.
  SELECT CASE
    WHEN split_part(p_path, '/', 1) ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(p_path, '/', 1)::uuid
  END
$$;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the photo bucket';
    RETURN;
  END IF;

  -- Private, not public. A group photo is a picture of somebody's friends on
  -- holiday; it is read through a signed URL by people in the group and by
  -- nobody else (ADR-013). 5 MB and three image types is enough for a cover
  -- and keeps the free tier's storage honest (ADR-011).
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('group-photos', 'group-photos', false, 5242880,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "group photos are readable by members" ON storage.objects;
    CREATE POLICY "group photos are readable by members" ON storage.objects
      FOR SELECT TO authenticated, anon
      USING (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "group photos are writable by members" ON storage.objects;
    CREATE POLICY "group photos are writable by members" ON storage.objects
      FOR INSERT TO authenticated, anon
      WITH CHECK (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "group photos are replaceable by members" ON storage.objects;
    CREATE POLICY "group photos are replaceable by members" ON storage.objects
      FOR UPDATE TO authenticated, anon
      USING (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "group photos are removable by members" ON storage.objects;
    CREATE POLICY "group photos are removable by members" ON storage.objects
      FOR DELETE TO authenticated, anon
      USING (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
      );
  $policy$;
END
$$;
