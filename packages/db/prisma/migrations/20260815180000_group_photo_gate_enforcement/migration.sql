-- Enforce the group-photo paid gate on the server, not only in the UI.
--
-- 20260815170000 added `baaki_can_upload_group_photo`, but the app used it only
-- to choose the picker vs the icon path — the actual writes still went through
-- RLS that checked *membership alone*:
--   * the `group-photos` storage INSERT/UPDATE policies (20260805120000), and
--   * the `groups` UPDATE path for `photo_path` (row-scoped by is_group_member,
--     with a column guard that never mentioned photo_path).
-- So any member could bypass the gate with a direct `PUT` of the object and a
-- `PATCH /groups?id=eq.X {photo_path:...}` under their own JWT. The gate was a
-- suggestion, not a boundary. This closes both write boundaries, and removes a
-- side channel that let any client probe an arbitrary profile's paid status.

-- 1. `baaki_profile_is_paid` was granted to authenticated/anon, which let any
--    client call it on ANY profile id and learn whether that person pays — a
--    definer function reading `subscriptions`, which RLS otherwise hides. No
--    client needs it directly: the only legitimate caller is
--    `baaki_can_upload_group_photo`, a SECURITY DEFINER function that runs as
--    its owner and so keeps EXECUTE regardless of the client grant.
REVOKE EXECUTE ON FUNCTION public.baaki_profile_is_paid(uuid) FROM authenticated, anon;

-- 2. The `groups` column guard now also gates `photo_path`. Setting or changing
--    it to a real path requires the paid gate; clearing it (removing the photo)
--    is always allowed — a group that loses its paying member can still fall
--    back to an icon, which is exactly what the app already does. Service-role,
--    SECURITY DEFINER and migration paths stay exempt via the current_user
--    check, unchanged from 20260815120000; only the photo_path block is added.
CREATE OR REPLACE FUNCTION public.baaki_guard_group_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.updated_seq IS DISTINCT FROM OLD.updated_seq THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: updated_seq is set by the server, not the client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

  -- A group photo is a paid feature (ADR-011 addendum). Only gate setting one;
  -- clearing it back to NULL is free and always allowed.
  IF NEW.photo_path IS DISTINCT FROM OLD.photo_path
     AND NEW.photo_path IS NOT NULL
     AND NOT public.baaki_can_upload_group_photo(NEW.id) THEN
    RAISE EXCEPTION 'PHOTO_GATE: a group photo is a paid feature'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

-- 3. The storage write boundaries. A member may still read and remove; setting
--    a photo (INSERT a new object, or UPDATE-replace an existing one) now also
--    requires the paid gate for the object's group. Guarded by the storage
--    schema's presence so CI's bare Postgres skips it, exactly like the policies
--    it supersedes (20260805120000).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the photo policies';
    RETURN;
  END IF;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "group photos are writable by members" ON storage.objects;
    CREATE POLICY "group photos are writable by members" ON storage.objects
      FOR INSERT TO authenticated, anon
      WITH CHECK (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
        AND public.baaki_can_upload_group_photo(public.baaki_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "group photos are replaceable by members" ON storage.objects;
    CREATE POLICY "group photos are replaceable by members" ON storage.objects
      FOR UPDATE TO authenticated, anon
      USING (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
        AND public.baaki_can_upload_group_photo(public.baaki_group_from_storage_path(name))
      );
  $policy$;
END
$$;
