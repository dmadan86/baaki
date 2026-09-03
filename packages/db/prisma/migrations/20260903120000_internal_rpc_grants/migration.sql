-- The internal RPC families a signed-in caller could reach directly.
--
-- Two families of SECURITY DEFINER functions were only ever meant to be called
-- from server code holding the service key, but carried the audit's stock
-- `GRANT ALL ... TO authenticated`, which put them one PostgREST `rpc/` call
-- away from any account:
--
--   • `baaki_storage_*` — the R2 cap ledger. `r2-sign`, `storage-sweep` and
--     `storage-recount` call these with the service client and have already
--     checked who the caller is. The functions themselves check nothing:
--     `baaki_storage_release(bucket, path)` is a bare DELETE on
--     `storage_objects`, whose BEFORE DELETE trigger queues the key for the
--     sweep to remove from R2, and `baaki_storage_reserve` / `_record` take
--     the acting identity as `p_profile_id`. A member could release another
--     member's object, or reserve gigabytes against a stranger's free-tier cap.
--
--   • `baaki_next_*_seq` — the sync watermarks. Each does an unconditional
--     `UPDATE ... SET updated_seq = updated_seq + 1 WHERE id = p_id`. Called in
--     a loop against a group the caller is not in, it walks that group's
--     watermark past every member's cursor and their mirrors stop receiving
--     changes. Nothing in the app calls these; the `baaki_stamp_*` triggers do.
--
-- Both families are revoked from `authenticated` (and `anon`, for the default
-- grant the hardening migration explains) and left to `service_role`.
--
-- ───────────────────────────────────── 1. the stamp triggers become definer ──
--
-- The `baaki_stamp_*` trigger functions are what actually take a sequence,
-- and they are SECURITY INVOKER: when a member's own INSERT under RLS fires
-- one, `baaki_next_group_seq` runs as `authenticated`, and revoking the grant
-- would break that write. Making the trigger functions SECURITY DEFINER is
-- the correct shape anyway — a trigger runs regardless of the firing user's
-- EXECUTE privilege, cannot be called directly (it returns `trigger`), and its
-- only job is to touch a counter the caller has no business reaching. They
-- already pin search_path (anon_surface_hardening §1).
--
-- `baaki_stamp_group_seq` bumps the row in place and calls nothing; it is
-- included so the six read the same.

ALTER FUNCTION public.baaki_stamp_capture_seq() SECURITY DEFINER;
ALTER FUNCTION public.baaki_stamp_category_tag_seq() SECURITY DEFINER;
ALTER FUNCTION public.baaki_stamp_ghost_merge_seq() SECURITY DEFINER;
ALTER FUNCTION public.baaki_stamp_group_seq() SECURITY DEFINER;
ALTER FUNCTION public.baaki_stamp_personal_seq() SECURITY DEFINER;
ALTER FUNCTION public.baaki_stamp_seq() SECURITY DEFINER;

-- Now that they are definer they would show on the signed-out surface with
-- their baseline `TO anon` grants. Nobody needs EXECUTE on a trigger function.
REVOKE ALL ON FUNCTION public.baaki_stamp_capture_seq() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_stamp_category_tag_seq() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_stamp_ghost_merge_seq() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_stamp_group_seq() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_stamp_personal_seq() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_stamp_seq() FROM PUBLIC, anon, authenticated;
-- The orphan-queue trigger was already definer and carries the same grant.
REVOKE ALL ON FUNCTION public.baaki_storage_enqueue_orphan() FROM PUBLIC, anon, authenticated;

-- ───────────────────────────────────────────── 2. the sequence functions ──

REVOKE ALL ON FUNCTION public.baaki_next_capture_seq(p_owner uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_next_category_tag_seq(p_owner uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_next_ghost_merge_seq(p_owner uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_next_group_seq(p_group_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_next_personal_seq(p_owner uuid) FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────── 3. the storage cap ledger ──
--
-- `baaki_storage_counts` is the helper the other two call to decide whether a
-- profile is under the cap; on its own it answers "is this profile or group
-- paid" for any id, which is nobody's business either.

REVOKE ALL ON FUNCTION public.baaki_storage_counts(p_profile_id uuid, p_group_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_storage_expire_pending(p_age interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_storage_orphan_clear(p_logical_bucket text, p_path text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_storage_orphans(p_limit integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_storage_record(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_storage_recount(p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_storage_release(p_logical_bucket text, p_path text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_storage_release_reservation(p_logical_bucket text, p_path text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baaki_storage_reserve(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────── 4. stop handing anon every new object ──
--
-- The baseline carries Supabase's stock default privileges, which grant every
-- function and table created by `postgres` in `public` to `anon` at creation.
-- That is the mechanism anon_surface_hardening describes and closes after the
-- fact; this closes it at the source. Nothing signed-out has needed a new
-- object since the three pre-sign-in tables, and each of those is granted by
-- name. `authenticated` and `service_role` keep their defaults.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
