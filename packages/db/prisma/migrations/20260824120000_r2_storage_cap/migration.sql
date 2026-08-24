-- Object storage moves to Cloudflare R2, and free accounts get an aggregate
-- image-storage ceiling (ADR-011 addendum / A44).
--
-- Two new facts the database has to hold that Supabase Storage held implicitly
-- before:
--
--   1. A ledger of every object the app writes to R2. Supabase Storage kept its
--      own `storage.objects` rows we could COUNT and SUM; R2 is opaque to
--      Postgres, so the size and ownership of each object has to be recorded
--      here at write time or the cap has nothing to measure against.
--
--   2. A per-user byte ceiling. The receipt cap (`app_config.receipt_cap_per_group`,
--      20260818160000) counts *receipts per group*; this counts *bytes per
--      person* across every image they upload. Same table, same trust model —
--      a numeric knob the console turns, readable by clients, written by the
--      service role alone.
--
-- The rule the ledger encodes (A44):
--   * a paid uploader is never capped, and their bytes are never counted;
--   * an image uploaded into a group whose owner is paid is uncapped for
--     everyone in it — "a paid group's receipts are free for its members";
--   * otherwise the bytes count against the *uploader's* personal ceiling
--     (10 MB by default), receipts and group photos and avatars alike.
--
-- "Owner is paid" is read through `baaki_group_is_paid` (20260818160000): any
-- member's subscription, or an unexpired group pass, frees the whole group.

-- ─────────────────────────────────────────────── the knob ──

INSERT INTO public.app_config (key, value, description)
VALUES (
  'free_storage_cap_bytes',
  10485760, -- 10 MiB
  'Total image bytes a free account may store in R2 before it must upgrade.'
)
ON CONFLICT (key) DO NOTHING;

/**
 * The per-user byte ceiling, with a floor so a missing row is generous rather
 * than a lockout (mirrors `baaki_receipt_cap`).
 */
CREATE OR REPLACE FUNCTION public.baaki_free_storage_cap()
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT value FROM public.app_config WHERE key = 'free_storage_cap_bytes'),
    10485760
  )::bigint;
$$;

GRANT EXECUTE ON FUNCTION public.baaki_free_storage_cap() TO authenticated, anon, service_role;

-- ─────────────────────────────────────────────── the ledger ──

/**
 * One row per object the app has written to R2.
 *
 *  - `logical_bucket` is the old Supabase bucket name (`receipts`,
 *    `group-photos`, `avatars`, `captures`) — R2 stores everything in one
 *    physical bucket, keyed `<logical_bucket>/<path>`, so the pair
 *    (logical_bucket, path) is the object's identity.
 *  - `owner_profile_id` is who the bytes are charged to (the uploader).
 *  - `group_id` is the group the object belongs to, when it has one — null for
 *    avatars and personal receipts. It is kept so `counted` can be recomputed
 *    if a group's paid status ever changes (a re-record refreshes the row).
 *  - `counted` is the decision at write time: do these bytes count against the
 *    owner's ceiling. Stored, not derived on read, so the SUM that enforces the
 *    cap is a plain indexed aggregate and never re-evaluates entitlement per row.
 */
CREATE TABLE IF NOT EXISTS public.storage_objects (
  logical_bucket   text        NOT NULL,
  path             text        NOT NULL,
  owner_profile_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  group_id         uuid        REFERENCES public.groups(id) ON DELETE CASCADE,
  bytes            bigint      NOT NULL CHECK (bytes >= 0),
  content_type     text        NOT NULL DEFAULT 'image/webp',
  counted          boolean     NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (logical_bucket, path)
);

-- The cap query is "SUM(bytes) for this owner where counted"; index exactly that.
CREATE INDEX IF NOT EXISTS storage_objects_owner_counted_idx
  ON public.storage_objects (owner_profile_id)
  WHERE counted;

ALTER TABLE public.storage_objects ENABLE ROW LEVEL SECURITY;

-- No client policies: the ledger is written and read only by the service role
-- through the RPCs below and the r2-sign edge function. A client that could
-- edit its own byte tally could lift its own cap.
REVOKE ALL ON public.storage_objects FROM anon, authenticated;

-- ──────────────────────────────── does an upload count ──

/**
 * Whether an upload's bytes count against the uploader's ceiling (A44).
 *
 * Free uploader, and the target is not a paid group → counted. A paid uploader
 * is never counted; a paid-owned group is never counted for anyone. Personal
 * images (no group) count for a free uploader — they are still that person's
 * bytes.
 *
 * SECURITY DEFINER so it can read subscriptions the caller cannot; it returns
 * only a boolean.
 */
CREATE OR REPLACE FUNCTION public.baaki_storage_counts(p_profile_id uuid, p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT NOT public.baaki_profile_is_paid(p_profile_id)
     AND NOT (p_group_id IS NOT NULL AND public.baaki_group_is_paid(p_group_id));
$$;

REVOKE ALL ON FUNCTION public.baaki_storage_counts(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_storage_counts(uuid, uuid) TO service_role;

-- ──────────────────────────────── may the caller store more ──

/**
 * May `p_profile_id` store `p_bytes` more at (bucket, path)?
 *
 *   * upload does not count (paid uploader, or paid group) → always yes;
 *   * otherwise yes while (already-counted bytes, excluding this same object)
 *     plus the new bytes stays within the ceiling.
 *
 * Excluding the object at (p_logical_bucket, p_path) makes a re-upload measure
 * the *delta*, not double-count: replacing a 2 MB cover with a 2 MB cover must
 * not spend 4 MB of the ceiling.
 *
 * The affordance the client draws and the gate the edge function checks before
 * it mints a PUT URL. `baaki_storage_record` re-checks at the write, so a
 * client that ignores this still cannot exceed the ceiling.
 */
CREATE OR REPLACE FUNCTION public.baaki_storage_can_upload(
  p_profile_id     uuid,
  p_group_id       uuid,
  p_logical_bucket text,
  p_path           text,
  p_bytes          bigint
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_used bigint;
BEGIN
  IF p_profile_id IS NULL OR p_bytes IS NULL OR p_bytes < 0 THEN
    RETURN false;
  END IF;

  IF NOT public.baaki_storage_counts(p_profile_id, p_group_id) THEN
    RETURN true;
  END IF;

  SELECT COALESCE(SUM(bytes), 0) INTO v_used
    FROM public.storage_objects
   WHERE owner_profile_id = p_profile_id
     AND counted
     AND NOT (logical_bucket = p_logical_bucket AND path = p_path);

  RETURN v_used + p_bytes <= public.baaki_free_storage_cap();
END
$$;

REVOKE ALL ON FUNCTION public.baaki_storage_can_upload(uuid, uuid, text, text, bigint) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_storage_can_upload(uuid, uuid, text, text, bigint) TO service_role;

-- ──────────────────────────────── the write, and the boundary ──

/**
 * Record (or refresh) a stored object, enforcing the ceiling as it does.
 *
 * Called by the r2-sign edge function after the client's PUT to R2 succeeds.
 * The ceiling is checked here too — this is the real boundary, the presign gate
 * is only the affordance — and a violation raises `STORAGE_CAP` so the edge
 * function can delete the just-uploaded object and answer 402. `counted` is
 * (re)computed from current entitlement on every record, so a re-upload after a
 * group turned paid stops counting without a backfill.
 */
CREATE OR REPLACE FUNCTION public.baaki_storage_record(
  p_profile_id     uuid,
  p_group_id       uuid,
  p_logical_bucket text,
  p_path           text,
  p_bytes          bigint,
  p_content_type   text DEFAULT 'image/webp'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_counted boolean := public.baaki_storage_counts(p_profile_id, p_group_id);
BEGIN
  IF p_profile_id IS NULL OR p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'STORAGE_BAD_INPUT' USING ERRCODE = 'check_violation';
  END IF;

  IF v_counted
     AND NOT public.baaki_storage_can_upload(
       p_profile_id, p_group_id, p_logical_bucket, p_path, p_bytes
     )
  THEN
    RAISE EXCEPTION 'STORAGE_CAP'
      USING ERRCODE = 'check_violation',
            HINT = 'You have reached your free storage limit; upgrade to add more.';
  END IF;

  INSERT INTO public.storage_objects
    (logical_bucket, path, owner_profile_id, group_id, bytes, content_type, counted)
  VALUES
    (p_logical_bucket, p_path, p_profile_id, p_group_id, p_bytes, p_content_type, v_counted)
  ON CONFLICT (logical_bucket, path) DO UPDATE
    SET owner_profile_id = excluded.owner_profile_id,
        group_id         = excluded.group_id,
        bytes            = excluded.bytes,
        content_type     = excluded.content_type,
        counted          = excluded.counted,
        updated_at       = now();
END
$$;

REVOKE ALL ON FUNCTION public.baaki_storage_record(uuid, uuid, text, text, bigint, text) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_storage_record(uuid, uuid, text, text, bigint, text) TO service_role;

/**
 * Forget an object — called when the app deletes it from R2. Idempotent: a path
 * that was never recorded is simply nothing to remove.
 */
CREATE OR REPLACE FUNCTION public.baaki_storage_release(
  p_logical_bucket text,
  p_path           text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.storage_objects
   WHERE logical_bucket = p_logical_bucket AND path = p_path;
$$;

REVOKE ALL ON FUNCTION public.baaki_storage_release(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_storage_release(text, text) TO service_role;

-- ──────────────────────────────── avatar read visibility ──

/**
 * Whether two profiles share at least one live group — the read scope an avatar
 * carried under Supabase Storage RLS. The r2-sign edge function asks this before
 * it mints a presigned GET for an avatar, so an R2 avatar URL reaches only the
 * same people the old signed URL would have.
 *
 * SECURITY DEFINER because neither profile can enumerate the other's memberships
 * under RLS; it returns only a boolean.
 */
CREATE OR REPLACE FUNCTION public.baaki_profiles_share_group(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_a = p_b OR EXISTS (
    SELECT 1
      FROM public.group_members ma
      JOIN public.group_members mb ON mb.group_id = ma.group_id
     WHERE ma.profile_id = p_a AND ma.left_at IS NULL
       AND mb.profile_id = p_b AND mb.left_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION public.baaki_profiles_share_group(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_profiles_share_group(uuid, uuid) TO service_role;

-- ──────────────────────────────── what the client shows ──

/**
 * The signed-in caller's own storage usage, for a "3.2 of 10 MB" meter and to
 * decide when to show the upgrade prompt before an upload is even attempted.
 *
 * Returns bytes used (only the counted ones — a paid account reads 0 used) and
 * the current ceiling. SECURITY DEFINER, but scoped hard to the caller's own
 * profile: it reveals nobody else's tally.
 */
CREATE OR REPLACE FUNCTION public.baaki_my_storage_usage()
RETURNS TABLE (used_bytes bigint, cap_bytes bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
BEGIN
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT COALESCE(SUM(bytes), 0)::bigint,
           public.baaki_free_storage_cap()
      FROM public.storage_objects
     WHERE owner_profile_id = v_profile
       AND counted;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_my_storage_usage() FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_my_storage_usage() TO authenticated;
