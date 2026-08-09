-- A browsable signup directory for the console.
--
-- This is a deliberate step past the aggregates-only line the other
-- `baaki_admin_*` functions hold (ADR-013): it returns names, contacts,
-- country and per-account facts, not counts. It is justified the same way the
-- existing user-admin actions are — confirming an address, comping a grant —
-- which already read one named account at a time through the GoTrue admin API.
-- The difference here is that support needs to *find* the account (by the name
-- someone gives on a call, by country) before acting on it, and paging the
-- whole GoTrue directory in Node to do that is both slow and unfilterable.
-- So this does the finding in SQL: filter, sort and paginate server-side, and
-- hand back only the page asked for.
--
-- SECURITY DEFINER because it reads `auth.users`, which Supabase grants to
-- nobody — the function runs as its owner (the migration role) instead. It is
-- revoked from PUBLIC/anon/authenticated and granted to `service_role` alone,
-- exactly like the aggregate functions, so it is reachable only from the admin
-- server and never from a browser holding the anon key.
--
-- Guarded on `auth.users` existing: CI runs migrations against bare Postgres,
-- which has no `auth` schema at all, so there it returns an empty page rather
-- than failing to plan. The body is dynamic for the same reason — the
-- reference to `auth.users` is parsed at call time, after the guard.

CREATE OR REPLACE FUNCTION public.baaki_admin_users(
  p_limit       integer DEFAULT 25,
  p_offset      integer DEFAULT 0,
  p_name_prefix text    DEFAULT NULL,
  p_country     text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_total  bigint := 0;
  v_rows   jsonb  := '[]'::jsonb;
  v_prefix text   := nullif(btrim(coalesce(p_name_prefix, '')), '');
  v_country text  := nullif(upper(btrim(coalesce(p_country, ''))), '');
  -- The page size is clamped so one lookup cannot become a walk of the whole
  -- directory, and the offset floored at zero.
  v_limit  int    := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int    := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RETURN jsonb_build_object('total', 0, 'rows', '[]'::jsonb, 'unavailable', 'no auth schema');
  END IF;

  EXECUTE format(
    $q$
      WITH base AS (
        SELECT
          u.id,
          u.email,
          u.phone,
          (u.email_confirmed_at IS NOT NULL)  AS email_confirmed,
          COALESCE(u.is_anonymous, false)     AS is_anonymous,
          u.created_at,
          u.last_sign_in_at,
          p.display_name,
          p.country_code,
          EXISTS (
            SELECT 1 FROM public.subscriptions s
             WHERE s.profile_id = u.id
               AND s.tier = 'plus'
               AND s.status IN ('active', 'grace')
          ) AS is_plus,
          (SELECT count(*) FROM public.device_sessions d
             WHERE d.profile_id = u.id AND d.revoked_at IS NULL) AS device_count,
          (SELECT d.app_version FROM public.device_sessions d
             WHERE d.profile_id = u.id AND d.app_version IS NOT NULL
             ORDER BY d.last_seen_at DESC LIMIT 1) AS app_version,
          (SELECT d.platform FROM public.device_sessions d
             WHERE d.profile_id = u.id
             ORDER BY d.last_seen_at DESC LIMIT 1) AS platform
        FROM auth.users u
        LEFT JOIN public.profiles p ON p.id = u.id
        WHERE (%1$L IS NULL OR p.display_name ILIKE %2$L OR u.email ILIKE %2$L)
          AND (%3$L IS NULL OR p.country_code = %3$L)
      )
      SELECT
        (SELECT count(*) FROM base),
        COALESCE(
          (SELECT jsonb_agg(to_jsonb(t))
             FROM (SELECT * FROM base ORDER BY created_at DESC OFFSET %4$s LIMIT %5$s) t),
          '[]'::jsonb
        )
    $q$,
    v_prefix,                 -- %1$L  null check
    v_prefix || '%',          -- %2$L  prefix match (name + email)
    v_country,                -- %3$L  country null check + equality
    v_offset,                 -- %4$s
    v_limit                   -- %5$s
  )
  INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END
$fn$;

-- Same grant discipline as the aggregate functions: Postgres grants EXECUTE to
-- PUBLIC by default and anon/authenticated inherit it in Supabase, so this is
-- revoked and handed to service_role alone.
REVOKE ALL ON FUNCTION public.baaki_admin_users(integer, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_users(integer, integer, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_admin_users(integer, integer, text, text) TO service_role;
