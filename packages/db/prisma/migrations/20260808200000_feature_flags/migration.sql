-- Experiments, and the switch that runs them.
--
-- A flag says what a feature is doing; a variant says which half of the
-- population is seeing it. Both are decided by **hashing, never by storing**.
-- A stored assignment is a row that must be written before the feature can
-- render — on a phone that is offline (ADR-005), for a guest with no round trip
-- to spare, at the moment the screen needs an answer. A hash has none of that.
--
-- The important consequence is that the analysis becomes a join. Because the
-- bucket is a pure function of ids the database already holds, the console can
-- ask "what did the treatment group actually do" straight from `profiles` —
-- no exposure events, no second source of truth to drift out of step.
--
-- `baaki_bucket` below is the same FNV-1a as `bucketOf` in
-- `packages/core/src/flags/bucket.ts`, written twice because the app decides
-- what to show and the console counts what happened. If the two ever disagree,
-- every experiment result is not missing but **wrong**, which is worse. The
-- fixtures in `BUCKET_FIXTURES` are asserted against this implementation by
-- `packages/db/test/featureFlags.test.ts` and against the TypeScript one by
-- `packages/core/test/flags.test.ts`.
--
-- Following the rule the security audit left behind, and A16: the table is
-- readable by clients and written by nobody but the service role. A flag a
-- client could flip is a paywall with a door in the back.

-- ──────────────────────────────────────────────────────────── the switch ──

/**
 * Whether an array holds no duplicates.
 *
 * A function because Postgres refuses a subquery inside a CHECK constraint —
 * `cannot use subquery in check constraint`, SQLSTATE 0A000 — and answering
 * "are these distinct" needs one. A check may call a function, so the subquery
 * moves in here. IMMUTABLE is required for a constraint to trust it.
 */
CREATE OR REPLACE FUNCTION public.baaki_array_is_distinct(p_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_values IS NULL
      OR cardinality(p_values) = (SELECT count(DISTINCT v) FROM unnest(p_values) AS v);
$$;

CREATE TABLE IF NOT EXISTS public.feature_flags (
  key text PRIMARY KEY,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  -- How much of the population is in the experiment at all.
  rollout_percent integer NOT NULL DEFAULT 0,
  -- At least two. The first is the control by convention, never by force.
  variants text[] NOT NULL DEFAULT ARRAY['control', 'treatment'],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Lowercase identifier: the key is concatenated into a hash input and read
  -- from client code, and a flag differing from another only by case is a bug
  -- nobody will find.
  CONSTRAINT feature_flags_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  CONSTRAINT feature_flags_rollout_range CHECK (rollout_percent BETWEEN 0 AND 100),
  CONSTRAINT feature_flags_variant_count CHECK (
    array_length(variants, 1) BETWEEN 2 AND 8
  ),
  -- A duplicate arm silently doubles that arm's share of the split.
  CONSTRAINT feature_flags_variants_distinct CHECK (public.baaki_array_is_distinct(variants))
);

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- Readable by everybody signed in, including anonymous guests — a guest sees
-- the same app as anybody else and needs the same answers. There is nothing
-- secret in a flag: it is configuration, not data about a person.
DROP POLICY IF EXISTS feature_flags_read ON public.feature_flags;
CREATE POLICY feature_flags_read ON public.feature_flags
  FOR SELECT TO anon, authenticated USING (true);

-- No INSERT, UPDATE or DELETE policy exists, so with RLS on, only the service
-- role (which bypasses it) can write. That is the whole write path.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.feature_flags FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────── the hash ──

/**
 * FNV-1a, 32 bit, folded to 0–99.
 *
 * Byte-wise over UTF-8 rather than character-wise, because the TypeScript side
 * hashes `TextEncoder` output and a plpgsql `ascii()` loop would agree with it
 * on every ASCII input and disagree on the first Tamil one.
 *
 * IMMUTABLE is load-bearing: it lets Postgres use this inside the index-free
 * aggregate in `baaki_admin_flag_results` without re-planning per row.
 */
CREATE OR REPLACE FUNCTION public.baaki_bucket(p_input text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bytes bytea := convert_to(COALESCE(p_input, ''), 'UTF8');
  v_hash bigint := 2166136261;
  v_index integer;
BEGIN
  FOR v_index IN 0 .. length(v_bytes) - 1 LOOP
    v_hash := v_hash # get_byte(v_bytes, v_index)::bigint;
    v_hash := (v_hash * 16777619) % 4294967296;
  END LOOP;
  RETURN (v_hash % 100)::integer;
END
$$;

/**
 * The variant a person sees, or NULL for "not in this experiment".
 *
 * NULL is not the control group and no caller may treat it as one. Somebody
 * outside the rollout should see whatever the app did before the flag existed;
 * folding them into the control puts people who were never enrolled into a
 * number meant to describe people who were.
 *
 * Rollout and variant hash different strings deliberately. Sharing one bucket
 * ties them together, so widening the rollout would hand every newly-included
 * person the same variant — a 100/0 split inside the new cohort, while the
 * total still looked even.
 */
CREATE OR REPLACE FUNCTION public.baaki_variant(p_key text, p_profile_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_flag public.feature_flags%ROWTYPE;
  v_arms integer;
BEGIN
  SELECT * INTO v_flag FROM public.feature_flags WHERE key = p_key;
  IF NOT FOUND OR NOT v_flag.enabled OR p_profile_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_arms := array_length(v_flag.variants, 1);
  IF v_arms IS NULL OR v_arms < 2 THEN
    RETURN NULL;
  END IF;

  IF public.baaki_bucket(p_key || ':' || p_profile_id::text) >= v_flag.rollout_percent THEN
    RETURN NULL;
  END IF;

  -- 1-based, so this matches the TypeScript's `variants[bucket % length]`.
  RETURN v_flag.variants[
    1 + (public.baaki_bucket(p_key || ':' || p_profile_id::text || ':variant') % v_arms)
  ];
END
$$;

-- ──────────────────────────────────────────────────────── what it changed ──

/**
 * The experiment's result: one row per arm, with what those people did.
 *
 * No exposure table feeds this. Every profile is bucketed on the fly by the
 * same function the app uses, which is the whole payoff of hashing over
 * storing — an experiment can be analysed retrospectively, including for the
 * days before anybody thought to log an exposure.
 *
 * People outside the rollout are excluded rather than reported as a third row.
 * They are not a control group; they are people the experiment never touched,
 * and putting them beside the arms invites exactly the comparison that is
 * wrong.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_flag_results(p_key text)
RETURNS TABLE (
  variant text,
  people bigint,
  expenses_created bigint,
  active_30d bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH enrolled AS (
    SELECT p.id AS profile_id, public.baaki_variant(p_key, p.id) AS variant
      FROM public.profiles p
     WHERE public.baaki_variant(p_key, p.id) IS NOT NULL
  ),
  per_person AS (
    SELECT
      e.variant,
      e.profile_id,
      (SELECT count(*)
         FROM public.expenses x
         JOIN public.group_members m ON m.id = x.created_by
        WHERE m.profile_id = e.profile_id AND x.deleted_at IS NULL) AS expenses,
      EXISTS (
        SELECT 1
          FROM public.activity_log a
          JOIN public.group_members m ON m.id = a.actor_member_id
         WHERE m.profile_id = e.profile_id
           AND a.created_at >= now() - interval '30 days'
      ) AS active
    FROM enrolled e
  )
  SELECT
    variant,
    count(*)::bigint,
    COALESCE(sum(expenses), 0)::bigint,
    count(*) FILTER (WHERE active)::bigint
  FROM per_person
  GROUP BY variant
  ORDER BY variant;
$$;

-- ─────────────────────────────────────────────────────────────── grants ──

-- The bucket and the variant are pure functions over public configuration, so
-- a client calling them learns nothing it could not compute itself — and the
-- app does compute them itself, from `@baaki/core`. They are exposed anyway so
-- the edge functions can gate on the same answer without reimplementing it.
GRANT EXECUTE ON FUNCTION public.baaki_bucket(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.baaki_variant(text, uuid) TO anon, authenticated, service_role;

-- The results are the business, and belong to the console alone.
REVOKE ALL ON FUNCTION public.baaki_admin_flag_results(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_flag_results(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_admin_flag_results(text) TO service_role;
