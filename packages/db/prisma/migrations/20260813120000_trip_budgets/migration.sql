-- Trip budgets: an overall ceiling the admin sets, and a personal ceiling each
-- member sets for themselves.
--
-- The whole reason this is worth doing in Baaki and not in a spreadsheet is the
-- same reason the planner is: the ledger is already here. "Spent" is never
-- entered — it is the sum of a member's `expense_shares`, which every co-member
-- can already see. So this migration stores only the *targets*, and the app
-- draws a progress bar by dividing what the ledger already knows by them.
--
-- Two targets, two homes, for one reason — privacy:
--
--   * The **overall** budget is one number for the trip, set by an admin, seen
--     by everyone. It lives on `groups`, which is already group-visible. It is
--     never private, so it needs no gate.
--
--   * A **personal** budget is one row per member in `trip_member_budgets`, and
--     it may be private. Privacy is row-level so RLS can enforce it and the
--     client cannot leak it: a `private` row is simply never returned to anyone
--     but its owner. A client that hid a private cap in the UI while the API
--     still shipped it would be a leak; here the API does not ship it.
--
-- What is *spent* is not stored and is not private — it is the shared ledger,
-- which everyone already sees. Only the target a person sets is hidden.

-- ─────────────────────────────────────────────────────── overall budget ──

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS budget_minor    bigint,
  ADD COLUMN IF NOT EXISTS budget_currency char(3);

-- A negative ceiling is not a ceiling. Zero is allowed — "we are spending
-- nothing more" is a real thing an admin might say.
ALTER TABLE public.groups
  DROP CONSTRAINT IF EXISTS groups_budget_sane;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_budget_sane
  CHECK (budget_minor IS NULL OR budget_minor >= 0);

-- ─────────────────────────────────────────────── personal budget table ──

CREATE TABLE IF NOT EXISTS public.trip_member_budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
  /** One budget per member. member_id is a group_members.id, unique to a group. */
  member_id    uuid NOT NULL UNIQUE REFERENCES public.group_members(id) ON DELETE CASCADE ON UPDATE CASCADE,
  amount_minor bigint NOT NULL,
  currency     char(3) NOT NULL DEFAULT 'INR',
  /** 'private' (owner-only) or 'group' (everyone in the group). */
  visibility   text NOT NULL DEFAULT 'private',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_member_budgets_amount_sane CHECK (amount_minor >= 0),
  CONSTRAINT trip_member_budgets_visibility_valid CHECK (visibility IN ('private', 'group'))
);

CREATE INDEX IF NOT EXISTS trip_member_budgets_group_id_idx
  ON public.trip_member_budgets (group_id);

ALTER TABLE public.trip_member_budgets ENABLE ROW LEVEL SECURITY;

-- The gate. A member of the group sees a personal budget when it is shared with
-- the group, or when it is their own. A private budget belonging to somebody
-- else matches no clause and is never returned — not to a co-member, not to an
-- admin. "Private" here means private, full stop.
CREATE POLICY trip_member_budgets_select ON public.trip_member_budgets
  FOR SELECT TO anon, authenticated
  USING (
    public.is_group_member(group_id)
    AND (visibility = 'group' OR member_id = public.baaki_my_member_id(group_id))
  );

-- No direct write. The RPCs below are the only way in — a client writing this
-- table directly could set `member_id` to somebody else and put a budget in a
-- stranger's name, the same reason the planner is RPC-only.
REVOKE ALL ON public.trip_member_budgets FROM anon, authenticated;
GRANT SELECT ON public.trip_member_budgets TO anon, authenticated;

-- ────────────────────────────────────────────────────────────── writing ──

/**
 * Set (or change) the caller's own personal budget for a trip. Upsert: a member
 * has at most one. `p_currency` NULL takes the group's default. Visibility flips
 * the row between private and group with the same call that sets the amount, so
 * sharing is one tap and needs no second endpoint.
 */
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
        updated_at   = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_set_my_trip_budget(uuid, bigint, character, text)
  TO authenticated, anon;

/** Remove the caller's own personal budget. Deleting one that is already gone
 *  is not an error. */
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
  DELETE FROM public.trip_member_budgets
  WHERE group_id = p_group_id AND member_id = v_member;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_clear_my_trip_budget(uuid) TO authenticated, anon;

/**
 * Set the overall trip budget. Admin only — the overall ceiling is the group's,
 * and letting any member move it would make it nobody's. `p_amount_minor` NULL
 * clears it (and its currency with it).
 */
CREATE OR REPLACE FUNCTION public.baaki_set_group_budget(
  p_group_id     uuid,
  p_amount_minor bigint  DEFAULT NULL,
  p_currency     char(3) DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_currency char(3);
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN: only an admin sets the overall budget'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_amount_minor IS NOT NULL AND p_amount_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: a budget is zero or more'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  UPDATE public.groups SET
    budget_minor    = p_amount_minor,
    budget_currency = CASE WHEN p_amount_minor IS NULL THEN NULL ELSE upper(v_currency) END,
    updated_at      = now()
  WHERE id = p_group_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_set_group_budget(uuid, bigint, character)
  TO authenticated, anon;
