-- A trip's plan, day by day.
--
-- Baaki already knows when a trip runs (`start_date`, `end_date`, `time_zone`)
-- and what it cost. What it has never held is what anybody *meant* to do — and
-- that is the half that makes a planner here worth more than a planner
-- anywhere else. Any notes app can hold "Dudhsagar falls" under Saturday. Only
-- the app that already has the ledger can say the falls were budgeted at ₹2,000
-- and came to ₹3,150, and that the trip is ₹4,000 over on day four.
--
-- A plan item is **not** money. It is an intention, it moves nobody's balance,
-- and it is deliberately not an expense with a flag: an expense that has not
-- happened would show up in balances, in exports and in simplification, and
-- every one of those would be wrong. The link between the two is one nullable
-- column, set when somebody says "this is what that was".

CREATE TABLE IF NOT EXISTS public.trip_plan_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
  /** The day it is planned for, in the trip's own timezone. A date, never a timestamp. */
  day           date NOT NULL,
  /** Time of day, or NULL for "sometime that day". */
  starts_at     time,
  title         text NOT NULL,
  note          text,
  category      text,
  /**
   * What somebody thinks it will cost, in minor units. NULL is "no idea yet",
   * which is a different thing from zero and must not be counted as budgeted.
   */
  planned_minor bigint,
  currency      char(3) NOT NULL DEFAULT 'INR',
  /** Ticked off. A plan item is done when somebody says so, not when it is paid. */
  done_at       timestamptz,
  /** What it turned out to be, once somebody links them. */
  expense_id    uuid REFERENCES public.expenses(id) ON DELETE SET NULL ON UPDATE CASCADE,
  /** Hand-ordering within a day, for the things that have no time. */
  position      int NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES public.group_members(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_plan_items_title_present CHECK (btrim(title) <> ''),
  -- A negative budget is not a budget. Zero is allowed: "the beach is free" is
  -- a real thing to plan.
  CONSTRAINT trip_plan_items_planned_sane CHECK (planned_minor IS NULL OR planned_minor >= 0)
);

CREATE INDEX IF NOT EXISTS trip_plan_items_group_day_idx
  ON public.trip_plan_items (group_id, day, position);

ALTER TABLE public.trip_plan_items ENABLE ROW LEVEL SECURITY;

-- Everybody in the group sees the plan; that is the point of a shared one.
CREATE POLICY trip_plan_items_select ON public.trip_plan_items
  FOR SELECT TO anon, authenticated
  USING (public.is_group_member(group_id));

-- No INSERT, UPDATE or DELETE policy, and no privilege either. The RPCs below
-- are the only way in, for the reason the security audit left behind: a client
-- that writes the table directly gets to choose `created_by`, and "who added
-- this" is not a question a client answers about itself.
REVOKE ALL ON public.trip_plan_items FROM anon, authenticated;
GRANT SELECT ON public.trip_plan_items TO anon, authenticated;

-- ────────────────────────────────────────────────────────────── writing ──

CREATE OR REPLACE FUNCTION public.baaki_add_plan_item(
  p_group_id      uuid,
  p_day           date,
  p_title         text,
  p_starts_at     time DEFAULT NULL,
  p_note          text DEFAULT NULL,
  p_category      text DEFAULT NULL,
  p_planned_minor bigint DEFAULT NULL,
  p_currency      char(3) DEFAULT NULL,
  p_item_id       uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id       uuid;
  v_position int;
  v_currency char(3);
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF coalesce(btrim(p_title), '') = '' THEN
    RAISE EXCEPTION 'INVALID_TITLE: a plan item needs a name' USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying a create must return the same item, not a second one (ADR-005) —
  -- a planner is used on a phone with one bar of signal by definition.
  IF p_item_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.trip_plan_items WHERE id = p_item_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  SELECT COALESCE(max(position), -1) + 1 INTO v_position
  FROM public.trip_plan_items WHERE group_id = p_group_id AND day = p_day;

  INSERT INTO public.trip_plan_items
    (id, group_id, day, starts_at, title, note, category, planned_minor, currency,
     position, created_by)
  VALUES
    (COALESCE(p_item_id, gen_random_uuid()), p_group_id, p_day, p_starts_at, btrim(p_title),
     p_note, p_category, p_planned_minor, upper(v_currency), v_position,
     public.baaki_my_member_id(p_group_id))
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_add_plan_item(
  uuid, date, text, time, text, text, bigint, character, uuid
) TO authenticated, anon;

/**
 * Change one. Anybody in the group may — a shared plan that only its author can
 * edit is a plan that goes stale the moment they put their phone down.
 *
 * NULL means "leave alone" for every field, so a caller changing the time does
 * not have to resend the note. Clearing a budget or a time is done with
 * `p_clear`, because NULL cannot mean both "unchanged" and "empty".
 */
CREATE OR REPLACE FUNCTION public.baaki_update_plan_item(
  p_item_id       uuid,
  p_day           date DEFAULT NULL,
  p_starts_at     time DEFAULT NULL,
  p_title         text DEFAULT NULL,
  p_note          text DEFAULT NULL,
  p_category      text DEFAULT NULL,
  p_planned_minor bigint DEFAULT NULL,
  p_done          boolean DEFAULT NULL,
  p_expense_id    uuid DEFAULT NULL,
  p_clear         text[] DEFAULT '{}'
)
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
    RAISE EXCEPTION 'NOT_FOUND: no such plan item' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- An expense can only ever be one from this same group. Otherwise a plan item
  -- could point at a stranger's expense and leak its description through the
  -- join the app makes.
  IF p_expense_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expenses WHERE id = p_expense_id AND group_id = v_group_id
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_EXPENSE: that expense is not in this group'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  UPDATE public.trip_plan_items SET
    day           = COALESCE(p_day, day),
    starts_at     = CASE WHEN 'starts_at' = ANY(p_clear) THEN NULL
                         ELSE COALESCE(p_starts_at, starts_at) END,
    title         = COALESCE(NULLIF(btrim(COALESCE(p_title, '')), ''), title),
    note          = CASE WHEN 'note' = ANY(p_clear) THEN NULL ELSE COALESCE(p_note, note) END,
    category      = CASE WHEN 'category' = ANY(p_clear) THEN NULL
                         ELSE COALESCE(p_category, category) END,
    planned_minor = CASE WHEN 'planned_minor' = ANY(p_clear) THEN NULL
                         ELSE COALESCE(p_planned_minor, planned_minor) END,
    done_at       = CASE WHEN p_done IS NULL THEN done_at
                         WHEN p_done THEN COALESCE(done_at, now())
                         ELSE NULL END,
    expense_id    = CASE WHEN 'expense_id' = ANY(p_clear) THEN NULL
                         ELSE COALESCE(p_expense_id, expense_id) END,
    updated_at    = now()
  WHERE id = p_item_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_update_plan_item(
  uuid, date, time, text, text, text, bigint, boolean, uuid, text[]
) TO authenticated, anon;

/** Remove one. A plan is not a ledger — this is a real delete, not a tombstone. */
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
    RETURN; -- Already gone. Deleting twice is not an error.
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM public.trip_plan_items WHERE id = p_item_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_remove_plan_item(uuid) TO authenticated, anon;
