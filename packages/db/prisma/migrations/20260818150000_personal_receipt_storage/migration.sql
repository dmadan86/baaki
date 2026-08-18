-- Personal receipt storage on Waves — the paid "Storage" destination.
--
-- The Storage settings screen lets a Plus member back scanned receipts up to
-- Waves' own bucket instead of (or as well as) a personal cloud. Those receipts
-- land in the existing private `receipts` bucket under a per-user prefix,
-- `personal/<uid>/<captureId>.jpg`, distinct from the group-scoped receipts the
-- scanner writes (`<groupId>/…`, guarded by 20260805140000).
--
-- This adds the storage.objects policies for that prefix:
--   * a member may READ and DELETE their own personal receipts (owner match), and
--   * may INSERT/UPDATE them only while on Plus — the same paid gate the group
--     photo boundary uses (`baaki_can_upload_group_photo(NULL)` answers "is the
--     caller paid", 20260815170000/180000). Reading and removing stay free so a
--     lapsed subscriber can still get their receipts back and clean up.
--
-- The path is matched with `storage.foldername(name)`: element 1 is the literal
-- `personal`, element 2 is the owner's uid. The group-scoped policies are
-- untouched and never match here — `baaki_group_from_storage_path('personal/…')`
-- returns NULL for a non-UUID first segment (20260805120000), a denial not an
-- error — so the two prefixes coexist in one bucket without overlap.
--
-- Guarded by the storage schema's presence so CI's bare Postgres skips it,
-- exactly like the bucket and policies it builds on.

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping personal receipt policies';
    RETURN;
  END IF;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "personal receipts are readable by owner" ON storage.objects;
    CREATE POLICY "personal receipts are readable by owner" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
      );

    DROP POLICY IF EXISTS "personal receipts are writable by paid owner" ON storage.objects;
    CREATE POLICY "personal receipts are writable by paid owner" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
        AND public.baaki_can_upload_group_photo(NULL)
      );

    DROP POLICY IF EXISTS "personal receipts are replaceable by paid owner" ON storage.objects;
    CREATE POLICY "personal receipts are replaceable by paid owner" ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
      )
      WITH CHECK (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
        AND public.baaki_can_upload_group_photo(NULL)
      );

    DROP POLICY IF EXISTS "personal receipts are removable by owner" ON storage.objects;
    CREATE POLICY "personal receipts are removable by owner" ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
      );
  $policy$;
END
$$;
