-- What the operator can see, and nothing else.
--
-- These feed the admin console (apps/admin). Every one of them returns
-- **aggregates**: counts, sums per currency, rows per country per day. None of
-- them returns a description, a note, a display name, a payment handle or a
-- profile id, and that is the point rather than an oversight — the console is
-- for knowing how the app is used, not for reading what people spent money on.
-- Expense text in this product is frequently medical, legal or personal.
--
-- Functions rather than views, for the reason amendment A7 already gives: a
-- view is an object Prisma has an opinion about and `prisma migrate diff` is a
-- merge gate, so every derived read here is a function.
--
-- The grants at the foot are load-bearing. Postgres grants EXECUTE to PUBLIC on
-- a new function, and in Supabase both `anon` and `authenticated` inherit that,
-- so without the REVOKE any signed-in user — including an anonymous guest —
-- could call these over PostgREST and read the whole business. They are
-- revoked and granted to `service_role` alone, which is why the console reads
-- them from a server and never from a browser (ADR-013).

-- ─────────────────────────────────────────────────────── the headline ──

/**
 * One row, the numbers a dashboard opens with.
 *
 * "Active" is somebody who did something — an activity_log row — not somebody
 * who opened the app, because opening it is not recorded anywhere and pretending
 * otherwise would put a number on screen that means nothing.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_overview()
RETURNS TABLE (
  profiles_total bigint,
  profiles_new_7d bigint,
  profiles_new_30d bigint,
  groups_total bigint,
  groups_new_30d bigint,
  groups_active_30d bigint,
  expenses_total bigint,
  expenses_new_30d bigint,
  expenses_deleted bigint,
  settlements_total bigint,
  settlements_confirmed bigint,
  active_profiles_7d bigint,
  active_profiles_30d bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM public.profiles),
    (SELECT count(*) FROM public.profiles WHERE created_at >= now() - interval '7 days'),
    (SELECT count(*) FROM public.profiles WHERE created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.groups),
    (SELECT count(*) FROM public.groups WHERE created_at >= now() - interval '30 days'),
    (SELECT count(DISTINCT group_id) FROM public.activity_log
      WHERE created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.expenses WHERE deleted_at IS NULL),
    (SELECT count(*) FROM public.expenses
      WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.expenses WHERE deleted_at IS NOT NULL),
    (SELECT count(*) FROM public.settlements),
    (SELECT count(*) FROM public.settlements WHERE status = 'confirmed'),
    (SELECT count(DISTINCT m.profile_id)
       FROM public.activity_log a
       JOIN public.group_members m ON m.id = a.actor_member_id
      WHERE a.created_at >= now() - interval '7 days' AND m.profile_id IS NOT NULL),
    (SELECT count(DISTINCT m.profile_id)
       FROM public.activity_log a
       JOIN public.group_members m ON m.id = a.actor_member_id
      WHERE a.created_at >= now() - interval '30 days' AND m.profile_id IS NOT NULL);
$$;

-- ──────────────────────────────────────────────────────────── the trend ──

/**
 * A row per day, including the days nothing happened.
 *
 * `generate_series` rather than `GROUP BY day` on purpose: a chart drawn from
 * grouped rows silently closes the gaps, so a fortnight of no signups reads as
 * a gentle slope instead of a flat line. The flat line is the information.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_daily(p_days integer DEFAULT 30)
RETURNS TABLE (
  day date,
  new_profiles bigint,
  new_groups bigint,
  new_expenses bigint,
  active_profiles bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH days AS (
    SELECT generate_series(
      (current_date - (GREATEST(p_days, 1) - 1))::date,
      current_date,
      interval '1 day'
    )::date AS day
  )
  SELECT
    d.day,
    (SELECT count(*) FROM public.profiles p WHERE p.created_at::date = d.day),
    (SELECT count(*) FROM public.groups g WHERE g.created_at::date = d.day),
    (SELECT count(*) FROM public.expenses e
      WHERE e.created_at::date = d.day AND e.deleted_at IS NULL),
    (SELECT count(DISTINCT m.profile_id)
       FROM public.activity_log a
       JOIN public.group_members m ON m.id = a.actor_member_id
      WHERE a.created_at::date = d.day AND m.profile_id IS NOT NULL)
  FROM days d
  ORDER BY d.day;
$$;

-- ────────────────────────────────────────────────────────── where from ──

/**
 * Country, as far as this product actually knows it.
 *
 * `profiles.country_code` is the device locale the app read at signup, and
 * `groups.country_code` is where a group settles. Neither is IP geolocation and
 * neither should be read as one: a phone set to en-GB in Bengaluru counts as
 * GB here. NULL is reported as its own row rather than dropped, because "we do
 * not know" is a real and frequently large answer.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_geo()
RETURNS TABLE (
  country_code text,
  profile_count bigint,
  group_count bigint,
  expense_count bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH countries AS (
    SELECT DISTINCT country_code::text AS code FROM public.profiles
    UNION
    SELECT DISTINCT country_code::text AS code FROM public.groups
  )
  SELECT
    c.code,
    (SELECT count(*) FROM public.profiles p WHERE p.country_code::text IS NOT DISTINCT FROM c.code),
    (SELECT count(*) FROM public.groups g WHERE g.country_code::text IS NOT DISTINCT FROM c.code),
    (SELECT count(*)
       FROM public.expenses e
       JOIN public.groups g ON g.id = e.group_id
      WHERE g.country_code::text IS NOT DISTINCT FROM c.code AND e.deleted_at IS NULL)
  FROM countries c
  ORDER BY 2 DESC, 1;
$$;

-- ───────────────────────────────────────────────────────────── the money ──

/**
 * Volume per currency, never converted and never summed across currencies.
 *
 * The same rule the product itself follows (§8): adding rupees to dirhams
 * produces a number that is wrong in a way nobody can see. Amounts stay in
 * minor units — `sum(bigint)` is numeric, which is exact.
 *
 * Only current versions of live expenses count, so an edited expense is
 * counted once at its present value rather than once per revision.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_money()
RETURNS TABLE (
  currency text,
  expense_count bigint,
  expense_minor numeric,
  settlement_count bigint,
  settlement_minor numeric
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH live AS (
    SELECT v.currency::text AS currency, v.amount
      FROM public.expenses e
      JOIN public.expense_versions v ON v.id = e.current_version_id
     WHERE e.deleted_at IS NULL
  ),
  paid AS (
    SELECT s.currency::text AS currency, s.amount
      FROM public.settlements s
     WHERE s.status = 'confirmed'
  ),
  currencies AS (
    SELECT currency FROM live UNION SELECT currency FROM paid
  )
  SELECT
    c.currency,
    (SELECT count(*) FROM live l WHERE l.currency = c.currency),
    COALESCE((SELECT sum(l.amount) FROM live l WHERE l.currency = c.currency), 0),
    (SELECT count(*) FROM paid p WHERE p.currency = c.currency),
    COALESCE((SELECT sum(p.amount) FROM paid p WHERE p.currency = c.currency), 0)
  FROM currencies c
  ORDER BY 3 DESC;
$$;

-- ───────────────────────────────────────────────────────── what it costs ──

/**
 * The AI receipt pipeline's bill, per day (ADR-008/011).
 *
 * `usage_events` already meters this exactly, in minor units, because COGS is
 * money too. Grouped by currency alongside the tokens so a change in the model's
 * price is visible as a change in cost per scan rather than hidden in a total.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_ai_cost(p_days integer DEFAULT 30)
RETURNS TABLE (
  day date,
  currency text,
  events bigint,
  input_tokens bigint,
  output_tokens bigint,
  cost_minor numeric
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    u.created_at::date,
    u.currency::text,
    count(*),
    COALESCE(sum(u.input_tokens), 0)::bigint,
    COALESCE(sum(u.output_tokens), 0)::bigint,
    COALESCE(sum(u.cost_minor), 0)
  FROM public.usage_events u
  WHERE u.created_at >= current_date - (GREATEST(p_days, 1) - 1)
  GROUP BY 1, 2
  ORDER BY 1 DESC, 2;
$$;

-- ──────────────────────────────────────────────────────────── who signed in ──

/**
 * Sign-ins per day, from Supabase's own audit trail.
 *
 * Guarded and dynamic for two reasons. CI runs these migrations against bare
 * Postgres, which has no `auth` schema at all — the guarded DO block pattern
 * this repo already uses for the `auth.users` trigger. And Supabase prunes
 * `audit_log_entries`, so this answers "recently" and cannot be used to chart
 * a year: an empty result means the window has passed, not that nobody signed
 * in, and the console says so rather than drawing a zero.
 *
 * `last_sign_in_at` on `auth.users` is deliberately not used for this. It is a
 * snapshot of the most recent sign-in per user, so grouping it by day produces
 * a plausible-looking chart that is not a history of anything.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_logins(p_days integer DEFAULT 30)
RETURNS TABLE (
  day date,
  sign_ins bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('auth.audit_log_entries') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format(
    $q$
      SELECT a.created_at::date AS day, count(*)::bigint
        FROM auth.audit_log_entries a
       WHERE a.created_at >= current_date - (%s - 1)
         AND a.payload ->> 'action' IN ('login', 'token_refreshed')
       GROUP BY 1
       ORDER BY 1 DESC
    $q$,
    GREATEST(p_days, 1)
  );
END
$$;

-- ─────────────────────────────────────────────────────────────── grants ──

-- Everything above is revoked from PUBLIC first. `anon` and `authenticated`
-- inherit PUBLIC's grants in Supabase, so leaving the default in place would
-- publish the whole business behind the anon key that ships in the app binary.
DO $$
DECLARE
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.baaki_admin_overview()',
    'public.baaki_admin_daily(integer)',
    'public.baaki_admin_geo()',
    'public.baaki_admin_money()',
    'public.baaki_admin_ai_cost(integer)',
    'public.baaki_admin_logins(integer)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
  END LOOP;
END
$$;
