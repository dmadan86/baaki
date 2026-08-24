-- A trip's shared album: photos the group takes together, browsable as a strip
-- on an expense and as a grid on the trip screen.
--
-- This is a THIRD photo concept, deliberately distinct from the two the app
-- already has, and the distinction is the whole reason it needs its own table
-- rather than another column:
--   * the group *cover* photo (`groups.photo_path`) — one image, the group's
--     identity, a paid feature gated by `baaki_can_upload_group_photo`;
--   * a *receipt* — the evidence behind one expense's amount, OCR'd, one per
--     expense, never browsed as a gallery;
--   * an *album* photo (here) — the memory layer. Many per trip, optionally
--     pinned to an expense or a day, free for any member to add, and the thing
--     a person scrolls back through after the trip is over.
--
-- Like the trip plan (20260807160000) it is a group's shared list, not money:
-- it moves nobody's balance and never touches a split. So it rides the same
-- offline mirror the plan does — an `updated_seq` the /sync pull walks, stamped
-- by the shared `baaki_stamp_seq` trigger, and a soft-delete `deleted_at` so a
-- removal propagates to a second device as a tombstone (a hard DELETE never
-- reaches a seq-based pull). The bytes live in Cloudflare R2 under a new logical
-- bucket `trip-photos`, brokered by `r2-sign` and counted against the free-tier
-- storage cap exactly like a receipt; this table holds only the pointer.

CREATE TABLE IF NOT EXISTS public.trip_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
  /**
   * The expense this photo belongs to, or NULL for a photo of the trip itself
   * (a group meal, a view) that is not tied to one bill. SET NULL on delete —
   * losing the expense unpins the photo, it does not delete the memory.
   */
  expense_id   uuid REFERENCES public.expenses(id) ON DELETE SET NULL ON UPDATE CASCADE,
  /** The day it belongs to, in the trip's own timezone; NULL for "no day". */
  day          date,
  /** The R2 object key within the `trip-photos` bucket. Never a URL. */
  storage_path text NOT NULL,
  /** A one-line caption, optional. */
  caption      text,
  /** Who added it. SET NULL if that membership is later removed. */
  created_by   uuid REFERENCES public.group_members(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Sync plumbing (ADR-005), identical to trip_plan_items.
  updated_seq  bigint NOT NULL DEFAULT 0,
  deleted_at   timestamptz,

  CONSTRAINT trip_photos_path_present CHECK (btrim(storage_path) <> ''),
  CONSTRAINT trip_photos_caption_sane CHECK (caption IS NULL OR char_length(caption) <= 500)
);

CREATE INDEX IF NOT EXISTS trip_photos_group_day_idx
  ON public.trip_photos (group_id, day);
CREATE INDEX IF NOT EXISTS trip_photos_group_id_updated_seq_idx
  ON public.trip_photos (group_id, updated_seq);
-- The expense-detail strip reads by expense.
CREATE INDEX IF NOT EXISTS trip_photos_expense_idx
  ON public.trip_photos (expense_id);

DROP TRIGGER IF EXISTS trip_photos_stamp_seq ON public.trip_photos;
CREATE TRIGGER trip_photos_stamp_seq
  BEFORE INSERT OR UPDATE ON public.trip_photos
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

ALTER TABLE public.trip_photos ENABLE ROW LEVEL SECURITY;

-- Everybody in the group sees the album; that is the point of a shared one.
CREATE POLICY trip_photos_select ON public.trip_photos
  FOR SELECT TO anon, authenticated
  USING (public.is_group_member(group_id));

-- No INSERT/UPDATE/DELETE policy and no privilege: the RPCs below are the only
-- way in, for the same reason as the plan — a client that writes the row picks
-- its own `created_by`, and "who added this" is not a question a client answers
-- about itself.
REVOKE ALL ON public.trip_photos FROM anon, authenticated;
GRANT SELECT ON public.trip_photos TO anon, authenticated;

-- ────────────────────────────────────────────────────────────── writing ──

/**
 * Add one photo to the album. Membership is enough — an album is a shared, free
 * surface, not an admin one. `p_photo_id` is client-chosen and the idempotency
 * key: replaying a create returns the same row rather than a duplicate, which a
 * phone on trip signal will do. `p_expense_id`, when given, must be an expense
 * in THIS group, or a photo could pin to a stranger's bill and leak its
 * description through the join the app makes.
 */
CREATE OR REPLACE FUNCTION public.baaki_add_trip_photo(
  p_group_id     uuid,
  p_storage_path text,
  p_photo_id     uuid DEFAULT NULL,
  p_expense_id   uuid DEFAULT NULL,
  p_day          date DEFAULT NULL,
  p_caption      text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF coalesce(btrim(p_storage_path), '') = '' THEN
    RAISE EXCEPTION 'INVALID_PATH: a photo needs a stored image'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying a create must return the same row, not a second one (ADR-005).
  IF p_photo_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.trip_photos WHERE id = p_photo_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  IF p_expense_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expenses WHERE id = p_expense_id AND group_id = p_group_id
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_EXPENSE: that expense is not in this group'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.trip_photos
    (id, group_id, expense_id, day, storage_path, caption, created_by)
  VALUES
    (COALESCE(p_photo_id, gen_random_uuid()), p_group_id, p_expense_id, p_day,
     btrim(p_storage_path), NULLIF(btrim(COALESCE(p_caption, '')), ''),
     public.baaki_my_member_id(p_group_id))
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_add_trip_photo(uuid, text, uuid, uuid, date, text)
  TO authenticated, anon;

/**
 * Remove one. A soft delete, so the tombstone rides the pull to every device
 * (a hard DELETE would never reach a seq-based pull, leaving the photo on other
 * phones forever). The R2 bytes are freed separately: the client deletes the
 * object through `r2-sign` when online, and the storage sweep is the backstop
 * for a tombstone whose bytes were never reclaimed. Any member may remove a
 * photo, matching the plan — a shared list only its author can prune goes stale.
 */
CREATE OR REPLACE FUNCTION public.baaki_remove_trip_photo(p_photo_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.trip_photos WHERE id = p_photo_id;
  IF v_group_id IS NULL THEN
    RETURN; -- Never existed. Removing nothing is not an error.
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Only when still live, so removing twice does not re-stamp the tombstone.
  UPDATE public.trip_photos
     SET deleted_at = now()
   WHERE id = p_photo_id AND deleted_at IS NULL;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_remove_trip_photo(uuid) TO authenticated, anon;
