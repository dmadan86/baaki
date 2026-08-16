-- Make the trip plan and per-member budgets offline-first (ADR-005).
--
-- Both were direct-RPC only, so the plan screen was blank with no connection.
-- To ride the mirror they need what every group-scoped synced table has: an
-- `updated_seq` the /sync pull walks with `.gt('updated_seq', N)`, stamped by
-- the shared `baaki_stamp_seq` trigger (keyed on group_id, same as settlements
-- and expenses).
--
-- The load-bearing change is delete. A seq-based pull can only carry rows that
-- still exist, so a hard DELETE never reaches a second device — it would keep
-- showing an item the first device removed. Captures solved this by making
-- delete a soft `deleted_at` UPDATE that the pull carries as a tombstone; the
-- client mirror filters it out. Both delete RPCs here become soft-deletes, and
-- the per-member upsert clears the tombstone when a budget is set again.

-- 1. Sync columns + indexes + the stamping trigger, on both tables.
ALTER TABLE public.trip_plan_items
  ADD COLUMN IF NOT EXISTS updated_seq bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;

CREATE INDEX IF NOT EXISTS trip_plan_items_group_id_updated_seq_idx
  ON public.trip_plan_items (group_id, updated_seq);

DROP TRIGGER IF EXISTS trip_plan_items_stamp_seq ON public.trip_plan_items;
CREATE TRIGGER trip_plan_items_stamp_seq
  BEFORE INSERT OR UPDATE ON public.trip_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

ALTER TABLE public.trip_member_budgets
  ADD COLUMN IF NOT EXISTS updated_seq bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;

CREATE INDEX IF NOT EXISTS trip_member_budgets_group_id_updated_seq_idx
  ON public.trip_member_budgets (group_id, updated_seq);

DROP TRIGGER IF EXISTS trip_member_budgets_stamp_seq ON public.trip_member_budgets;
CREATE TRIGGER trip_member_budgets_stamp_seq
  BEFORE INSERT OR UPDATE ON public.trip_member_budgets
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

-- Stamp the rows that already exist so a first pull carries them.
UPDATE public.trip_plan_items SET group_id = group_id;
UPDATE public.trip_member_budgets SET group_id = group_id;

-- 2. Removing a plan item is now a soft delete, so the tombstone propagates.
CREATE OR REPLACE FUNCTION public.baaki_remove_plan_item(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.trip_plan_items WHERE id = p_item_id;
  IF v_group_id IS NULL THEN
    RETURN; -- Never existed. Removing nothing is not an error.
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Soft delete, and only when still live, so removing twice does not re-stamp.
  UPDATE public.trip_plan_items
     SET deleted_at = now()
   WHERE id = p_item_id AND deleted_at IS NULL;
END
$$;

-- 3. Clearing a personal budget is a soft delete, keyed to the caller's member.
CREATE OR REPLACE FUNCTION public.baaki_clear_my_trip_budget(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member uuid;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_member := public.baaki_my_member_id(p_group_id);
  UPDATE public.trip_member_budgets
     SET deleted_at = now()
   WHERE group_id = p_group_id AND member_id = v_member AND deleted_at IS NULL;
END
$$;

-- 4. Setting a personal budget clears any prior tombstone, so the one row per
--    member (the UNIQUE key) comes back to life rather than colliding.
CREATE OR REPLACE FUNCTION public.baaki_set_my_trip_budget(
  p_group_id     uuid,
  p_amount_minor bigint,
  p_currency     char(3) DEFAULT NULL,
  p_visibility   text DEFAULT 'private'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member   uuid;
  v_currency char(3);
  v_id       uuid;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_member := public.baaki_my_member_id(p_group_id);
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you have no membership here'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_amount_minor IS NULL OR p_amount_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: a budget is zero or more'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_visibility NOT IN ('private', 'group') THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY: private or group'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  INSERT INTO public.trip_member_budgets
    (group_id, member_id, amount_minor, currency, visibility)
  VALUES
    (p_group_id, v_member, p_amount_minor, upper(v_currency), p_visibility)
  ON CONFLICT (member_id) DO UPDATE
    SET amount_minor = EXCLUDED.amount_minor,
        currency     = EXCLUDED.currency,
        visibility   = EXCLUDED.visibility,
        deleted_at   = NULL,
        updated_at   = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;
