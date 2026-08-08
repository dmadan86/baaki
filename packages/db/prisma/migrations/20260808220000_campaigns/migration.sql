-- A promotion somebody is actually told about, and a way to know if it worked.
--
-- A campaign is the announcement wrapped around a promo code: who should see
-- it, between which dates, and what it says. The code itself already exists —
-- this adds the telling, and the arithmetic afterwards.
--
-- **The holdout is the whole point.** "Revenue impact" of a giveaway is not the
-- value of what was given away; a comped subscription earns nothing by
-- construction. What matters is whether the people who were offered it went on
-- to pay more than the people who were not — so every campaign deliberately
-- withholds itself from a slice of its own audience, and the result is read as
-- the difference between those two groups. Without a holdout the honest answer
-- to "did this work" is "no idea", and a number printed next to that question
-- would be worse than a blank.
--
-- Cohort membership reuses `baaki_bucket` from the feature-flags migration, so
-- it needs no assignment rows and is stable for a person across the campaign's
-- whole life. Same hash, same reasoning.

-- ────────────────────────────────────────────────────────── the campaign ──

CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- What the person reads. Kept on the campaign rather than in the app's string
  -- table because it changes per campaign and is written by whoever runs one.
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  cta_label text NOT NULL DEFAULT '',
  -- The code the announcement is about. NULL is allowed: an announcement that
  -- gives nothing away is still a campaign.
  promo_code text REFERENCES public.promo_codes(code) ON DELETE SET NULL ON UPDATE CASCADE,

  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,

  -- ISO-3166 alpha-2 list, or NULL for everybody. Country here is the device
  -- locale the app read at signup, with all the imprecision that carries.
  audience_countries text[],
  -- The slice withheld on purpose, so there is something to compare against.
  holdout_percent integer NOT NULL DEFAULT 10,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaigns_window CHECK (ends_at > starts_at),
  CONSTRAINT campaigns_holdout_range CHECK (holdout_percent BETWEEN 0 AND 90),
  CONSTRAINT campaigns_title_present CHECK (length(trim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS campaigns_window_idx ON public.campaigns (starts_at, ends_at);

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

-- Deliberately no client-readable policy. The app never selects campaigns
-- directly: it asks `baaki_my_campaign()`, which answers with the one campaign
-- this caller should see and nothing else. A client that could read the table
-- would see campaigns aimed at other countries, campaigns not yet started, and
-- its own holdout status — which is the one thing that must not leak, because a
-- holdout who knows they are a holdout is no longer a control group.
REVOKE ALL ON public.campaigns FROM anon, authenticated;

-- ───────────────────────────────────────────────────────── who saw it ──

CREATE TABLE IF NOT EXISTS public.campaign_impressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE ON UPDATE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT now(),
  -- Set when they act on it rather than dismiss it.
  acted_at timestamptz,

  CONSTRAINT campaign_impressions_once UNIQUE (campaign_id, profile_id)
);

CREATE INDEX IF NOT EXISTS campaign_impressions_campaign_idx
  ON public.campaign_impressions (campaign_id, seen_at);

ALTER TABLE public.campaign_impressions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaign_impressions_own ON public.campaign_impressions;
CREATE POLICY campaign_impressions_own ON public.campaign_impressions
  FOR SELECT TO authenticated
  USING (profile_id = public.baaki_current_profile_id());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.campaign_impressions FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────── the cohort ──

/**
 * Whether somebody is in a campaign's holdout.
 *
 * Hashed on the campaign id, so a person held out of one campaign is not
 * systematically held out of the next — which would quietly build a permanent
 * never-told-anything cohort and bias every result that followed.
 */
CREATE OR REPLACE FUNCTION public.baaki_campaign_cohort(p_campaign_id uuid, p_profile_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_profile_id IS NULL THEN NULL
    WHEN public.baaki_bucket('campaign:' || p_campaign_id::text || ':' || p_profile_id::text)
         < (SELECT holdout_percent FROM public.campaigns WHERE id = p_campaign_id)
      THEN 'holdout'
    ELSE 'targeted'
  END;
$$;

/**
 * The campaign this caller should be shown, or nothing.
 *
 * SECURITY DEFINER because the table it reads is closed to clients, and it is
 * the only door into it. It answers with one row at most: running now, matching
 * their country, not already seen, and not held out. The holdout is filtered
 * here rather than reported, so the app has no way to render "you are in the
 * control group" even by accident.
 */
CREATE OR REPLACE FUNCTION public.baaki_my_campaign()
RETURNS TABLE (
  id uuid,
  title text,
  body text,
  cta_label text,
  promo_code text,
  ends_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.title, c.body, c.cta_label, c.promo_code, c.ends_at
    FROM public.campaigns c
    JOIN public.profiles p ON p.id = public.baaki_current_profile_id()
   WHERE now() BETWEEN c.starts_at AND c.ends_at
     AND (c.audience_countries IS NULL OR p.country_code = ANY (c.audience_countries))
     AND public.baaki_campaign_cohort(c.id, p.id) = 'targeted'
     AND NOT EXISTS (
       SELECT 1 FROM public.campaign_impressions i
        WHERE i.campaign_id = c.id AND i.profile_id = p.id
     )
   ORDER BY c.starts_at DESC
   LIMIT 1;
$$;

/**
 * Records that the announcement was actually put in front of somebody.
 *
 * Separate from the cohort because being targeted and having seen it are
 * different facts: a person who never opened the app during the campaign was
 * targeted and saw nothing, and a funnel that conflated the two would credit
 * the campaign with reaching people it never reached.
 */
CREATE OR REPLACE FUNCTION public.baaki_campaign_seen(p_campaign_id uuid, p_acted boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
BEGIN
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.campaign_impressions (campaign_id, profile_id, acted_at)
  VALUES (p_campaign_id, v_profile, CASE WHEN p_acted THEN now() ELSE NULL END)
  ON CONFLICT (campaign_id, profile_id) DO UPDATE
    SET acted_at = COALESCE(public.campaign_impressions.acted_at, EXCLUDED.acted_at);
END
$$;

-- ─────────────────────────────────────────────────────── did it work ──

/**
 * The funnel, per cohort.
 *
 * `people` counts everybody the campaign could have reached — matching country,
 * existing when it started — split by cohort. Everything after that is what
 * they went on to do. The holdout row will have zero seen and zero redeemed by
 * definition; it is there for `paid`, which is the only column the comparison
 * actually turns on.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_campaign_funnel(p_campaign_id uuid)
RETURNS TABLE (
  cohort text,
  people bigint,
  seen bigint,
  redeemed bigint,
  paid bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH c AS (
    SELECT * FROM public.campaigns WHERE id = p_campaign_id
  ),
  audience AS (
    SELECT p.id AS profile_id,
           public.baaki_campaign_cohort(c.id, p.id) AS cohort
      FROM public.profiles p
      CROSS JOIN c
     WHERE (c.audience_countries IS NULL OR p.country_code = ANY (c.audience_countries))
       AND p.created_at <= c.ends_at
  )
  SELECT
    a.cohort,
    count(*)::bigint,
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM public.campaign_impressions i
         WHERE i.campaign_id = p_campaign_id AND i.profile_id = a.profile_id
      )
    )::bigint,
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
          FROM public.promo_redemptions r
          JOIN c ON c.promo_code = r.code
         WHERE r.profile_id = a.profile_id
      )
    )::bigint,
    -- Paid means a real store purchase, not the giveaway. `store <> 'promo'` is
    -- the whole distinction: counting the comped rows here would report every
    -- campaign as a total success.
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
          FROM public.subscriptions s
          CROSS JOIN c
         WHERE s.profile_id = a.profile_id
           AND s.store <> 'promo'
           AND s.created_at >= c.starts_at
      )
    )::bigint
  FROM audience a
  GROUP BY a.cohort
  ORDER BY a.cohort;
$$;

/**
 * What was actually earned, per cohort and currency.
 *
 * Never summed across currencies, for the reason the rest of this schema
 * gives: adding rupees to dirhams produces a number wrong in a way nobody can
 * see. Promo rows are excluded — they carry no price and are not revenue.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_campaign_revenue(p_campaign_id uuid)
RETURNS TABLE (
  cohort text,
  currency text,
  payers bigint,
  revenue_minor numeric
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH c AS (
    SELECT * FROM public.campaigns WHERE id = p_campaign_id
  )
  SELECT
    public.baaki_campaign_cohort(c.id, s.profile_id),
    s.currency::text,
    count(DISTINCT s.profile_id)::bigint,
    COALESCE(sum(s.price_minor), 0)
  FROM public.subscriptions s
  JOIN public.profiles p ON p.id = s.profile_id
  CROSS JOIN c
  WHERE s.store <> 'promo'
    AND s.price_minor IS NOT NULL
    AND s.currency IS NOT NULL
    AND s.created_at >= c.starts_at
    AND (c.audience_countries IS NULL OR p.country_code = ANY (c.audience_countries))
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

-- ─────────────────────────────────────────────────────────────── grants ──

-- The app may ask what it should show and say that it showed it. Nothing else.
REVOKE ALL ON FUNCTION public.baaki_my_campaign() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_my_campaign() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.baaki_campaign_seen(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_campaign_seen(uuid, boolean) TO authenticated, service_role;

-- The cohort must never be answerable by a client: a holdout who learns they
-- are a holdout has stopped being a control group.
REVOKE ALL ON FUNCTION public.baaki_campaign_cohort(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_campaign_cohort(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_campaign_cohort(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_admin_campaign_funnel(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_campaign_funnel(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_admin_campaign_funnel(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_admin_campaign_revenue(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_campaign_revenue(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_admin_campaign_revenue(uuid) TO service_role;
