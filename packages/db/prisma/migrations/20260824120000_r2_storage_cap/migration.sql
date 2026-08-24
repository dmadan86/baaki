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
  -- A reservation, not yet a stored object. `put` writes the row `pending` so its
  -- bytes count against the ceiling the moment the URL is minted — otherwise a
  -- client could presign endlessly and never `commit`, filling R2 while the cap,
  -- which only saw committed rows, measured nothing. `commit` clears it; a
  -- reservation nobody commits is swept after `baaki_storage_expire_pending`.
  pending          boolean     NOT NULL DEFAULT false,
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

-- The cap is enforced in exactly one place — `baaki_storage_reserve` at the
-- presign, re-checked in `baaki_storage_record` at the commit — so there is no
-- separate "can I upload" predicate to keep in step with it. A client that wants
-- to grey out an upload before trying reads `baaki_my_storage_usage` and does the
-- arithmetic itself; it is never the authority.

-- ──────────────────────────────── reserve before the PUT ──

/**
 * The most concurrent reservations one account may hold at once. A reservation
 * is only released by `commit`, `delete`, or the 30-minute sweep, so this bounds
 * how much a client that presigns-and-abandons can strand in R2 between sweeps —
 * without it, "reserve 1 byte, upload a lot, never commit" repeats forever. Eight
 * is far above any real burst (a receipt scan, an avatar) yet a hard ceiling on
 * abuse.
 */
-- (kept inline in baaki_storage_reserve; documented here for the "why 8".)

/**
 * Reserve space for an upload that is about to happen, enforcing the ceiling as
 * it does (A44). Called by `r2-sign` *before* it mints a presigned PUT, so the
 * bytes are charged the instant the URL exists rather than at `commit` — a
 * presign the client never commits still holds cap until it is swept, which is
 * what stops the "presign forever, commit never" hole from filling R2 for free.
 *
 * A per-owner advisory lock makes the read-the-sum-then-write two-step atomic:
 * two uploads racing can no longer both read the old total and both slip under
 * the ceiling (the TOCTOU the plain check had). `commit` takes the same lock.
 *
 * Raises `STORAGE_CAP` over the ceiling and `STORAGE_TOO_MANY_PENDING` when the
 * account is sitting on too many un-committed reservations.
 */
CREATE OR REPLACE FUNCTION public.baaki_storage_reserve(
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
  v_counted       boolean;
  v_used          bigint;
  v_pending_count integer;
BEGIN
  IF p_profile_id IS NULL OR p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'STORAGE_BAD_INPUT' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialise every reserve/commit for this owner so the cap check and the write
  -- are one indivisible step.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  v_counted := public.baaki_storage_counts(p_profile_id, p_group_id);

  IF v_counted THEN
    -- Bound abandoned reservations (see the note above). A re-reservation of the
    -- same object is a replacement, not a new pending, so it is excluded.
    SELECT count(*) INTO v_pending_count
      FROM public.storage_objects
     WHERE owner_profile_id = p_profile_id
       AND pending
       AND NOT (logical_bucket = p_logical_bucket AND path = p_path);
    IF v_pending_count >= 8 THEN
      RAISE EXCEPTION 'STORAGE_TOO_MANY_PENDING'
        USING ERRCODE = 'check_violation',
              HINT = 'Too many uploads in flight; finish or wait a moment.';
    END IF;

    SELECT COALESCE(SUM(bytes), 0) INTO v_used
      FROM public.storage_objects
     WHERE owner_profile_id = p_profile_id
       AND counted
       AND NOT (logical_bucket = p_logical_bucket AND path = p_path);

    IF v_used + p_bytes > public.baaki_free_storage_cap() THEN
      RAISE EXCEPTION 'STORAGE_CAP'
        USING ERRCODE = 'check_violation',
              HINT = 'You have reached your free storage limit; upgrade to add more.';
    END IF;
  END IF;

  INSERT INTO public.storage_objects
    (logical_bucket, path, owner_profile_id, group_id, bytes, content_type, counted, pending)
  VALUES
    (p_logical_bucket, p_path, p_profile_id, p_group_id, p_bytes, p_content_type, v_counted, true)
  ON CONFLICT (logical_bucket, path) DO UPDATE
    SET owner_profile_id = excluded.owner_profile_id,
        group_id         = excluded.group_id,
        bytes            = excluded.bytes,
        content_type     = excluded.content_type,
        counted          = excluded.counted,
        pending          = true,
        updated_at       = now();
END
$$;

REVOKE ALL ON FUNCTION public.baaki_storage_reserve(uuid, uuid, text, text, bigint, text) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_storage_reserve(uuid, uuid, text, text, bigint, text) TO service_role;

-- ──────────────────────────────── the write, and the boundary ──

/**
 * Confirm a reserved object once its PUT to R2 has landed, clearing `pending`
 * and correcting its declared size to the true one the edge HEADed.
 *
 * Called by the r2-sign edge function after the client's PUT to R2 succeeds.
 * The ceiling is re-checked here under the same per-owner advisory lock the
 * reservation took — this is the real boundary, the presign gate is only the
 * affordance. It matters because the reservation trusted the client's *declared*
 * length; if the object actually landed larger (a client that low-balled the
 * size to slip past the cap), the true bytes are measured here and a violation
 * raises `STORAGE_CAP` so the edge function deletes the object and answers 402.
 * `counted` is (re)computed from current entitlement on every record, so a
 * re-upload after a group turned paid stops counting without a backfill.
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
  v_counted boolean;
  v_used    bigint;
BEGIN
  IF p_profile_id IS NULL OR p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'STORAGE_BAD_INPUT' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  v_counted := public.baaki_storage_counts(p_profile_id, p_group_id);

  IF v_counted THEN
    -- The true-size cap check, excluding this same object so a replacement
    -- measures the delta, not double.
    SELECT COALESCE(SUM(bytes), 0) INTO v_used
      FROM public.storage_objects
     WHERE owner_profile_id = p_profile_id
       AND counted
       AND NOT (logical_bucket = p_logical_bucket AND path = p_path);

    IF v_used + p_bytes > public.baaki_free_storage_cap() THEN
      RAISE EXCEPTION 'STORAGE_CAP'
        USING ERRCODE = 'check_violation',
              HINT = 'You have reached your free storage limit; upgrade to add more.';
    END IF;
  END IF;

  INSERT INTO public.storage_objects
    (logical_bucket, path, owner_profile_id, group_id, bytes, content_type, counted, pending)
  VALUES
    (p_logical_bucket, p_path, p_profile_id, p_group_id, p_bytes, p_content_type, v_counted, false)
  ON CONFLICT (logical_bucket, path) DO UPDATE
    SET owner_profile_id = excluded.owner_profile_id,
        group_id         = excluded.group_id,
        bytes            = excluded.bytes,
        content_type     = excluded.content_type,
        counted          = excluded.counted,
        pending          = false,
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

-- ──────────────────────────────── reclaiming stranded R2 bytes ──

/**
 * Objects that still exist in R2 but no longer have a ledger row — the R2 key
 * has to be deleted, but only the edge function holds an R2 credential, so the
 * database cannot do it inline. Every removal of a `storage_objects` row drops
 * its key here for the `storage-sweep` edge function to delete out-of-band.
 *
 * This is the one place that catches an object a cascade orphaned: deleting a
 * profile or a group cascades its `storage_objects` rows away, and without this
 * the R2 bytes would be stranded with nothing left pointing at them. The trigger
 * fires for that cascade exactly as it does for an explicit release.
 */
CREATE TABLE IF NOT EXISTS public.storage_orphans (
  logical_bucket text        NOT NULL,
  path           text        NOT NULL,
  enqueued_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (logical_bucket, path)
);

ALTER TABLE public.storage_orphans ENABLE ROW LEVEL SECURITY;
-- Service-role only, like the ledger itself.
REVOKE ALL ON public.storage_orphans FROM anon, authenticated;

/**
 * On any delete of a ledger row — explicit release, pending expiry, or a cascade
 * from a deleted profile/group — remember the R2 key so the sweep can reclaim it.
 * Idempotent: a key already queued (e.g. the explicit delete path already asked
 * R2 to remove it) simply stays queued, and the sweep's R2 DELETE is itself a
 * no-op on a missing key.
 */
CREATE OR REPLACE FUNCTION public.baaki_storage_enqueue_orphan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.storage_orphans (logical_bucket, path)
  VALUES (OLD.logical_bucket, OLD.path)
  ON CONFLICT (logical_bucket, path) DO NOTHING;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS storage_objects_enqueue_orphan ON public.storage_objects;
CREATE TRIGGER storage_objects_enqueue_orphan
  BEFORE DELETE ON public.storage_objects
  FOR EACH ROW EXECUTE FUNCTION public.baaki_storage_enqueue_orphan();

/**
 * Drop reservations nobody committed. A `pending` row older than the grace
 * window is an upload that was presigned and then abandoned; deleting the row
 * frees the cap it was holding and, via the trigger above, queues its R2 key for
 * reclamation. Idempotent and safe to run on any schedule.
 */
CREATE OR REPLACE FUNCTION public.baaki_storage_expire_pending(
  p_age interval DEFAULT interval '30 minutes'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.storage_objects
     WHERE pending AND updated_at <= now() - p_age
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM gone;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_storage_expire_pending(interval) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_storage_expire_pending(interval) TO service_role;

/** A batch of queued R2 keys for the sweep edge function to delete. */
CREATE OR REPLACE FUNCTION public.baaki_storage_orphans(p_limit integer DEFAULT 100)
RETURNS TABLE (logical_bucket text, path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT logical_bucket, path
    FROM public.storage_orphans
   ORDER BY enqueued_at
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 1000));
$$;

REVOKE ALL ON FUNCTION public.baaki_storage_orphans(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_storage_orphans(integer) TO service_role;

/** Forget a queued key once the sweep has deleted it from R2. */
CREATE OR REPLACE FUNCTION public.baaki_storage_orphan_clear(
  p_logical_bucket text,
  p_path           text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.storage_orphans
   WHERE logical_bucket = p_logical_bucket AND path = p_path;
$$;

REVOKE ALL ON FUNCTION public.baaki_storage_orphan_clear(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_storage_orphan_clear(text, text) TO service_role;

-- Expire abandoned reservations often, so the cap they hold is freed promptly
-- and the ceiling stays honest without any R2 credential (pure SQL). Reclaiming
-- the R2 *bytes* is the separate `storage-sweep` edge function's job; the
-- operator schedules that where the R2 secret lives (docs/r2-storage.md).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule('baaki-storage-expire-pending')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'baaki-storage-expire-pending');
    PERFORM cron.schedule(
      'baaki-storage-expire-pending', '*/15 * * * *',
      'SELECT public.baaki_storage_expire_pending()'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not scheduled: %', SQLERRM;
END
$$;

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
