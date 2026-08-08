-- Giving somebody the paid tier without taking their money.
--
-- The entitlements migration already left the door open: `store` accepts
-- 'promo' alongside 'play' and 'appstore', and `baaki_my_plan` reads any active
-- row regardless of where it came from. So a promotion is not a parallel
-- entitlement system — it is one more row in `subscriptions`, and every screen
-- that already asks "what plan is this person on" gets the right answer with no
-- change at all. Building a second source of truth for who has paid would be
-- the mistake here.
--
-- Two ways in, both ending at the same row:
--
--   * the console grants directly, for a support case or a thank-you;
--   * somebody types a code into the app, which is the same grant with a
--     gatekeeper in front of it.
--
-- Neither is a client write. `baaki_redeem_promo` is SECURITY DEFINER precisely
-- so the client never touches `subscriptions` — the rule the entitlements
-- migration set down still holds: a client that could insert its own
-- subscription row is a paywall with a door in the back.

-- ─────────────────────────────────────────────────────────────── the code ──

CREATE TABLE IF NOT EXISTS public.promo_codes (
  code text PRIMARY KEY,
  tier text NOT NULL DEFAULT 'plus',
  -- How long the grant lasts. Days rather than an end date so one code means
  -- the same thing to somebody redeeming it today and in a month.
  days integer NOT NULL DEFAULT 30,
  max_redemptions integer NOT NULL DEFAULT 1,
  redeemed_count integer NOT NULL DEFAULT 0,
  -- When the code stops working, which is not the same as when the grant ends.
  expires_at timestamptz,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Uppercase and unambiguous: these get read aloud and typed by hand.
  CONSTRAINT promo_codes_shape CHECK (code ~ '^[A-Z0-9]{4,24}$'),
  CONSTRAINT promo_codes_tier_known CHECK (tier IN ('plus')),
  CONSTRAINT promo_codes_days_sane CHECK (days BETWEEN 1 AND 3650),
  CONSTRAINT promo_codes_max_sane CHECK (max_redemptions BETWEEN 1 AND 1000000),
  CONSTRAINT promo_codes_count_sane CHECK (redeemed_count >= 0)
);

-- RLS with no policy at all: not even readable by a client. Everything else in
-- this schema is readable by the person it concerns, but a list of valid codes
-- is not about a person — it is the giveaway itself, and one SELECT would hand
-- somebody every unredeemed code in the table.
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promo_codes FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON UPDATE CASCADE on all three to match what Prisma generates for a
  -- relation, which is what `db:drift` compares against — the entitlements
  -- migration spells it out for the same reason.
  code text NOT NULL REFERENCES public.promo_codes(code) ON DELETE CASCADE ON UPDATE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE ON UPDATE CASCADE,
  subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL ON UPDATE CASCADE,
  redeemed_at timestamptz NOT NULL DEFAULT now(),

  -- One code, one person, once. The real guard is the unique store_txn_id on
  -- the subscription itself; this makes the intent readable.
  CONSTRAINT promo_redemptions_once UNIQUE (code, profile_id)
);

CREATE INDEX IF NOT EXISTS promo_redemptions_profile_idx
  ON public.promo_redemptions (profile_id, redeemed_at);

ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

-- Somebody may see that they redeemed something. They may not see who else did.
DROP POLICY IF EXISTS promo_redemptions_own ON public.promo_redemptions;
CREATE POLICY promo_redemptions_own ON public.promo_redemptions
  FOR SELECT TO authenticated
  USING (profile_id = public.baaki_current_profile_id());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.promo_redemptions FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────── granting it ──

/**
 * The shared tail of both paths: write the subscription row.
 *
 * `store_txn_id` is not decoration. The stores replay their webhooks
 * deliberately and often, so that column is unique to stop one purchase being
 * granted twice — and reusing it here means a promotion gets the same
 * protection for free. Two concurrent redemptions of the same code by the same
 * person race to the same key and one of them loses, without a lock and
 * without a subtle read-then-write window.
 */
CREATE OR REPLACE FUNCTION public.baaki_grant_promo(
  p_profile_id uuid,
  p_days integer,
  p_source text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.subscriptions
    (profile_id, tier, period, status, current_period_end, store, store_txn_id)
  VALUES (
    p_profile_id,
    'plus',
    'monthly',
    'active',
    now() + make_interval(days => p_days),
    'promo',
    p_source
  )
  ON CONFLICT (store_txn_id) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

/**
 * The app's side: somebody types a code.
 *
 * Returns a jsonb verdict rather than raising, because every failure here is a
 * thing to tell the person — expired, already used, not a code — and an
 * exception would reach them as a crash. The only thing that raises is being
 * signed out, which is a bug in the caller rather than a wrong code.
 *
 * The row is locked for the duration so the redemption count cannot be
 * overshot by two people typing the same code at the same moment.
 */
CREATE OR REPLACE FUNCTION public.baaki_redeem_promo(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
  v_code    public.promo_codes%ROWTYPE;
  v_sub     uuid;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;

  SELECT * INTO v_code
    FROM public.promo_codes
   WHERE code = upper(trim(COALESCE(p_code, '')))
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'UNKNOWN_CODE');
  END IF;

  IF v_code.expires_at IS NOT NULL AND v_code.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'EXPIRED');
  END IF;

  IF v_code.redeemed_count >= v_code.max_redemptions THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'EXHAUSTED');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.promo_redemptions
     WHERE code = v_code.code AND profile_id = v_profile
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_REDEEMED');
  END IF;

  v_sub := public.baaki_grant_promo(
    v_profile,
    v_code.days,
    'promo:' || v_code.code || ':' || v_profile::text
  );

  IF v_sub IS NULL THEN
    -- The unique key rejected it, so this person already holds this grant.
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_REDEEMED');
  END IF;

  INSERT INTO public.promo_redemptions (code, profile_id, subscription_id)
  VALUES (v_code.code, v_profile, v_sub);

  UPDATE public.promo_codes
     SET redeemed_count = redeemed_count + 1
   WHERE code = v_code.code;

  RETURN jsonb_build_object(
    'ok', true,
    'tier', v_code.tier,
    'days', v_code.days,
    'until', (now() + make_interval(days => v_code.days))
  );
END
$$;

/**
 * The console's side: comp one named account, no code involved.
 *
 * Deliberately keyed on the profile id and the day, so pressing the button
 * twice in a support conversation extends nothing — it is the same grant. To
 * genuinely give somebody a second month, grant again tomorrow or issue a code.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_grant_promo(
  p_profile_id uuid,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NO_SUCH_PROFILE');
  END IF;

  v_sub := public.baaki_grant_promo(
    p_profile_id,
    GREATEST(COALESCE(p_days, 30), 1),
    'admin:' || p_profile_id::text || ':' || current_date::text
  );

  IF v_sub IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_GRANTED_TODAY');
  END IF;

  RETURN jsonb_build_object('ok', true, 'subscription', v_sub);
END
$$;

-- ────────────────────────────────────────────── what the console can read ──

/**
 * Codes and how they are going. Counts only — who redeemed what is a list of
 * named people, and the console does not read those (see the admin analytics
 * migration for why).
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_promo_codes()
RETURNS TABLE (
  code text,
  tier text,
  days integer,
  max_redemptions integer,
  redeemed_count integer,
  expires_at timestamptz,
  note text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT code, tier, days, max_redemptions, redeemed_count, expires_at, note, created_at
    FROM public.promo_codes
   ORDER BY created_at DESC;
$$;

-- ─────────────────────────────────────────────────────────────── grants ──

-- The redeem path is the one thing here a client may call, and it is
-- SECURITY DEFINER so that it — and not the caller — does the writing.
REVOKE ALL ON FUNCTION public.baaki_redeem_promo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_redeem_promo(text) TO authenticated, service_role;

-- Granting is never a client's decision.
REVOKE ALL ON FUNCTION public.baaki_grant_promo(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_grant_promo(uuid, integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_grant_promo(uuid, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_admin_grant_promo(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_grant_promo(uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_admin_grant_promo(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_admin_promo_codes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_promo_codes() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_admin_promo_codes() TO service_role;
