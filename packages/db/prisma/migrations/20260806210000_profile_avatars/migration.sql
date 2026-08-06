-- Profile photos.
--
-- `profiles.avatar_url` has existed since the initial schema, filled only by
-- whatever Google handed over at sign-in. This adds the other way to get one:
-- the person chooses it.
--
-- The bucket is private like the other two (ADR-013). A face is not public
-- data, and the people entitled to see it are exactly the people you split
-- money with — so the read policy is "we are in a group together", and nothing
-- wider. Signed URLs do the rest.
--
-- The path is always `<profileId>/avatar.<ext>`, which is what every policy
-- below keys off. `baaki_group_from_storage_path` already parses that first
-- segment as a uuid for the group buckets; the same shape means the same
-- parsing rules, and a malformed path denies rather than raising.

-- ─────────────────────────────────────── who may look at whose face ──
-- SECURITY DEFINER because the honest version of this question reads
-- `group_members` twice, and that table's own RLS would otherwise be evaluated
-- inside a storage policy — a recursion that ends in a permission error rather
-- than an answer.

CREATE OR REPLACE FUNCTION public.baaki_shares_a_group_with(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_profile_id IS NOT NULL
     AND (
       -- Your own face, always.
       p_profile_id = public.baaki_current_profile_id()
       OR EXISTS (
         SELECT 1
         FROM public.group_members mine
         JOIN public.group_members theirs ON theirs.group_id = mine.group_id
         WHERE mine.profile_id = public.baaki_current_profile_id()
           AND theirs.profile_id = p_profile_id
           AND mine.left_at IS NULL
       )
     )
$$;

GRANT EXECUTE ON FUNCTION public.baaki_shares_a_group_with(uuid) TO authenticated, anon;


DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the avatar bucket';
    RETURN;
  END IF;

  -- 2 MB, not the 5 MB a group cover gets. An avatar is displayed at 78pt at
  -- its largest; the client downscales to 512px before it ever gets here, and
  -- the ceiling exists to catch the case where it did not (ADR-011).
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('avatars', 'avatars', false, 2097152,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "avatars are readable by people you split with" ON storage.objects;
    CREATE POLICY "avatars are readable by people you split with" ON storage.objects
      FOR SELECT TO authenticated, anon
      USING (
        bucket_id = 'avatars'
        AND public.baaki_shares_a_group_with(public.baaki_group_from_storage_path(name))
      );

    -- Writes are self-only. Reading a groupmate's face is ordinary; replacing
    -- it is impersonation.
    DROP POLICY IF EXISTS "avatars are writable by their owner" ON storage.objects;
    CREATE POLICY "avatars are writable by their owner" ON storage.objects
      FOR INSERT TO authenticated, anon
      WITH CHECK (
        bucket_id = 'avatars'
        AND public.baaki_group_from_storage_path(name) = public.baaki_current_profile_id()
      );

    DROP POLICY IF EXISTS "avatars are replaceable by their owner" ON storage.objects;
    CREATE POLICY "avatars are replaceable by their owner" ON storage.objects
      FOR UPDATE TO authenticated, anon
      USING (
        bucket_id = 'avatars'
        AND public.baaki_group_from_storage_path(name) = public.baaki_current_profile_id()
      );

    DROP POLICY IF EXISTS "avatars are removable by their owner" ON storage.objects;
    CREATE POLICY "avatars are removable by their owner" ON storage.objects
      FOR DELETE TO authenticated, anon
      USING (
        bucket_id = 'avatars'
        AND public.baaki_group_from_storage_path(name) = public.baaki_current_profile_id()
      );
  $policy$;
END
$$;
