-- The console's sign-in panel could not read the thing it counts.
--
-- Signing in and loading the dashboard returned a 500 and, in the browser,
-- "A server error occurred":
--
--   baaki_admin_logins failed: permission denied for table audit_log_entries
--
-- `baaki_admin_logins` is the only one of these functions that reads outside
-- `public`. The other five read tables `service_role` owns rights to; this one
-- reads `auth.audit_log_entries`, which belongs to `supabase_auth_admin` and is
-- granted to nobody. It was written without SECURITY DEFINER, so it ran as the
-- caller — and the caller has no business in the `auth` schema.
--
-- Two things were wrong and both are fixed here.

-- ────────────────────────────────────────── 1. borrow the owner's rights ──
--
-- SECURITY DEFINER, like every other function in this schema that has to reach
-- past what the caller may see. `search_path` is pinned for the usual reason:
-- a definer function that resolves names through the caller's path is a way to
-- run the caller's code as the owner.
--
-- The `to_regclass` guard stays. CI applies these migrations to bare Postgres,
-- which has no `auth` schema at all, and a function that cannot be created
-- there is a function nothing tests.

CREATE OR REPLACE FUNCTION public.baaki_admin_logins(p_days integer DEFAULT 30)
RETURNS TABLE (
  day date,
  sign_ins bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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

-- SECURITY DEFINER changes who the function runs as, not who may call it, and
-- CREATE OR REPLACE resets the grants a new function gets by default.
REVOKE ALL ON FUNCTION public.baaki_admin_logins(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_logins(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_admin_logins(integer) TO service_role;

-- ────────────────────────────── 2. make sure the owner can read it either ──
--
-- Being the definer is only half of it: the owner needs the SELECT too, and on
-- a Supabase project `postgres` does not have it on `auth.audit_log_entries`
-- as a matter of course.
--
-- Wrapped in an exception handler because there are three environments here and
-- the statement is right in one of them. On bare Postgres in CI the table does
-- not exist; on a project where `postgres` cannot grant on another role's
-- table, the GRANT is refused. Neither is a reason to fail a migration that has
-- already fixed the definer half — and the console now names the remaining
-- problem on the page instead of dying of it.
DO $$
BEGIN
  IF to_regclass('auth.audit_log_entries') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SCHEMA auth TO postgres';
    EXECUTE 'GRANT SELECT ON auth.audit_log_entries TO postgres';
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table OR undefined_object THEN
    RAISE NOTICE
      'Could not grant SELECT on auth.audit_log_entries to postgres (%). The '
      'sign-ins panel will say so; nothing else is affected.', SQLERRM;
END
$$;
