-- Who has paid for what, decided here and nowhere else.
--
-- ADR-011 draws the line and this migration sits on the paid side of it: the
-- ledger stays unlimited and free forever, and what a subscription buys is
-- convenience — scan volume past the free quota, and the analytics depth and
-- auto-import the app gates on the same answer.
--
-- **Nothing here is writable by a client.** Following the rule the security
-- audit left behind: every table below is readable only by the person it is
-- about, and written only by the service role, because the only honest source
-- of "this person paid" is a receipt verified against Google or Apple by
-- something holding a key the phone does not have. A client that could insert
-- its own subscription row is a paywall with a door in the back — the same
-- shape of bug as a settlement somebody could mark confirmed themselves.
--
-- Text with a CHECK rather than enums, for the same reason the payment rails
-- are: adding a tier or a store should be one migration and no type surgery.

-- ─────────────────────────────────────────────────── what somebody bought ──

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE ON UPDATE CASCADE,
  tier               text NOT NULL DEFAULT 'plus',
  period             text NOT NULL,
  status             text NOT NULL DEFAULT 'active',
  /**
   * When it lapses. NULL means it does not — a lifetime purchase, which is the
   * one thing here that is not a subscription at all.
   */
  current_period_end timestamptz,
  store              text NOT NULL,
  /**
   * The store's own transaction id. Unique, so replaying a webhook — which
   * both stores do, deliberately and often — cannot grant the same purchase
   * twice (the same rule as `client_mutation_id` on a mutation, ADR-005).
   */
  store_txn_id       text UNIQUE,
  /** What they actually paid, in the currency they actually paid it in. */
  price_minor        bigint,
  currency           char(3),
  country_code       char(2),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_tier_known CHECK (tier IN ('free', 'plus')),
  CONSTRAINT subscriptions_period_known CHECK (period IN ('monthly', 'yearly', 'lifetime')),
  CONSTRAINT subscriptions_status_known
    CHECK (status IN ('active', 'grace', 'expired', 'cancelled', 'refunded')),
  CONSTRAINT subscriptions_store_known CHECK (store IN ('play', 'appstore', 'promo')),
  -- A lifetime purchase has no end; everything else must say when it stops.
  CONSTRAINT subscriptions_end_matches_period
    CHECK ((period = 'lifetime') = (current_period_end IS NULL))
);

CREATE INDEX IF NOT EXISTS subscriptions_profile_idx
  ON public.subscriptions (profile_id, status);

-- ────────────────────────────────────────── what somebody bought for a group ──
--
-- A trip pass is bought by one person and enjoyed by everybody in the group.
-- That is the point of it: the buyer is being generous rather than out of
-- pocket, and five people who did not buy see what the paid tier does.

CREATE TABLE IF NOT EXISTS public.group_passes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
  purchased_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL ON UPDATE CASCADE,
  expires_at   timestamptz NOT NULL,
  store        text NOT NULL DEFAULT 'play',
  store_txn_id text UNIQUE,
  price_minor  bigint,
  currency     char(3),
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT group_passes_store_known CHECK (store IN ('play', 'appstore', 'promo'))
);

CREATE INDEX IF NOT EXISTS group_passes_group_idx
  ON public.group_passes (group_id, expires_at);

-- ────────────────────────────────────────────────────────────────── access ──

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_passes ENABLE ROW LEVEL SECURITY;

-- Read your own. There is no INSERT, UPDATE or DELETE policy on either table
-- and there is not meant to be: the service role writes them, and it bypasses
-- RLS. The grants below take the privilege away as well, so the refusal does
-- not depend on nobody ever adding a permissive policy by accident.
CREATE POLICY subscriptions_select_own ON public.subscriptions
  FOR SELECT TO authenticated
  USING (profile_id = public.baaki_current_profile_id());

-- A pass is visible to the group it covers, not only to whoever paid — the
-- other five people need to see that the trip is covered.
CREATE POLICY group_passes_select_members ON public.group_passes
  FOR SELECT TO anon, authenticated
  USING (public.is_group_member(group_id));

REVOKE ALL ON public.subscriptions FROM anon, authenticated;
REVOKE ALL ON public.group_passes FROM anon, authenticated;
GRANT SELECT ON public.subscriptions TO authenticated;
GRANT SELECT ON public.group_passes TO anon, authenticated;

-- ──────────────────────────────────────────────────── resolving the answer ──

/**
 * What this person is entitled to, right now.
 *
 * One place, so the scan quota, the analytics and the app all read the same
 * sentence. Returns free rather than nothing when there is no purchase, so a
 * caller never has to decide what an empty row means.
 */
CREATE OR REPLACE FUNCTION public.baaki_my_plan(p_profile_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := COALESCE(p_profile_id, public.baaki_current_profile_id());
  v_row     record;
BEGIN
  IF v_profile IS NULL THEN
    RETURN jsonb_build_object('tier', 'free', 'until', NULL, 'source', 'free', 'scanLimit', 20);
  END IF;

  SELECT period, current_period_end INTO v_row
  FROM public.subscriptions
  WHERE profile_id = v_profile
    AND tier = 'plus'
    -- 'grace' is still paid: the store is retrying a card, and taking the
    -- features away mid-retry punishes somebody whose bank was slow.
    AND status IN ('active', 'grace')
    AND (current_period_end IS NULL OR current_period_end > now())
  -- A lifetime purchase outranks a subscription that expires; otherwise the
  -- one that lasts longest wins. Somebody who bought both should get both.
  ORDER BY (current_period_end IS NULL) DESC, current_period_end DESC NULLS FIRST
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('tier', 'free', 'until', NULL, 'source', 'free', 'scanLimit', 20);
  END IF;

  RETURN jsonb_build_object(
    'tier', 'plus',
    'until', v_row.current_period_end,
    'source', CASE WHEN v_row.period = 'lifetime' THEN 'lifetime' ELSE 'subscription' END,
    'scanLimit', 300
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_my_plan(uuid) TO authenticated, anon;

/**
 * What applies inside one group — the caller's own plan, or a pass somebody
 * bought for everybody.
 *
 * Membership is checked, because otherwise this would answer questions about
 * groups the caller is not in.
 */
CREATE OR REPLACE FUNCTION public.baaki_group_plan(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mine    jsonb := public.baaki_my_plan();
  v_expires timestamptz;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_mine ->> 'tier' = 'plus' THEN
    RETURN v_mine;
  END IF;

  SELECT max(expires_at) INTO v_expires
  FROM public.group_passes
  WHERE group_id = p_group_id AND expires_at > now();

  IF v_expires IS NULL THEN
    RETURN v_mine;
  END IF;

  RETURN jsonb_build_object(
    'tier', 'plus', 'until', v_expires, 'source', 'trip_pass', 'scanLimit', 300
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_group_plan(uuid) TO authenticated, anon;

-- ─────────────────────────────────────────────────────── the quota itself ──
--
-- Was a hardcoded 20 in this function and a second hardcoded 20 in
-- `receipt-parse`. Now both read the plan, and the number lives once.

CREATE OR REPLACE FUNCTION public.baaki_receipt_scan_quota()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'used', public.baaki_scans_used_this_month(),
    'limit', (public.baaki_my_plan() ->> 'scanLimit')::int,
    'remaining', greatest(
      0,
      (public.baaki_my_plan() ->> 'scanLimit')::int - public.baaki_scans_used_this_month()
    ),
    'tier', public.baaki_my_plan() ->> 'tier'
  );
$$;

GRANT EXECUTE ON FUNCTION public.baaki_receipt_scan_quota() TO authenticated, anon;
