-- The scheduled jobs were callable by anybody with an account.
--
-- Found by running against the deployed project, and impossible to find any
-- other way, because local and Supabase disagreed about a default:
--
--   Supabase runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public
--   GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`.
--
-- So every function created there is granted to those roles *directly*, and
-- `REVOKE ALL ... FROM PUBLIC` — which is what the job migrations did — takes
-- away a grant that was never what let them in. A bare Postgres has no such
-- default, so the tests asserting "permission denied" passed locally while the
-- deployed database allowed all five.
--
-- What that meant, live:
--
--   * `baaki_auto_confirm_settlements()` — any signed-in person could confirm
--     every pending settlement in the database, in groups they are not in.
--   * `baaki_claim_push_notifications()` — returns other people's notification
--     text and their device push tokens.
--   * `baaki_finish_push()` — mark somebody else's notifications sent (so they
--     never arrive) and revoke anybody's device.
--   * `baaki_trip_nudges()` and `baaki_notify()` — write into other people's
--     inboxes.
--
-- Two fixes, because removing the grant is only half of it:
--
--   1. Revoke it, explicitly, from the roles that actually hold it.
--   2. Make local look like Supabase, so the next function to get this wrong
--      fails in the test suite instead of in production.

-- ──────────────────────────────── 1. local now has Supabase's default too ──
-- This is a no-op on Supabase, which already does it. On a plain Postgres it
-- reproduces the trap: from here on, a new function is granted to anon and
-- authenticated unless the migration says otherwise, exactly as it would be in
-- production — and the RLS tests will say so.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ─────────────────────────────────────────── 2. take the grant back again ──

DO $$
DECLARE
  v_signature TEXT;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.baaki_auto_confirm_settlements(timestamptz, interval)',
    'public.baaki_trip_nudges(timestamptz)',
    'public.baaki_claim_push_notifications(integer)',
    'public.baaki_finish_push(uuid[], uuid[], text[])',
    'public.baaki_notify(uuid, uuid, text, text, text, text, jsonb, text)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_signature);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_signature);
    END IF;
    -- The jobs run as the service role, and cron runs as the database owner.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
    END IF;
  END LOOP;
END
$$;

-- The RPCs that people *are* meant to call keep their grant, stated here so the
-- two lists sit next to each other and the difference is deliberate rather
-- than remembered.
GRANT EXECUTE ON FUNCTION
  public.baaki_mark_notifications_read(uuid[]),
  public.baaki_dispute_expense(uuid, text),
  public.baaki_withdraw_dispute(uuid),
  public.baaki_resolve_dispute(uuid, boolean, text)
TO authenticated, anon;
