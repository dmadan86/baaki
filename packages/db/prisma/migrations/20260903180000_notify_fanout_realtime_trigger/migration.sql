-- A fresh notification waited up to five minutes for the next cron tick, even
-- though `notify-fanout` was one HTTP call away from firing the instant the
-- row landed. This closes that gap for the common case with a trigger, and
-- leaves the cron (set up directly against prod, not migration-tracked — see
-- docs/notify-fanout-scheduling.md) doing the one thing a trigger structurally
-- cannot: notice that a retry has come due purely because time passed, with
-- no new row to fire an AFTER INSERT off of. Belt and suspenders, not either/or.
--
-- The URL below names this project (`xvjzbpgcmotoahtqcxve`) the same way the
-- cron job does — the one line here that is not portable; see the doc above
-- for what to change it to on a different project. Everything else is safe on
-- a fresh clone or self-host database with no Vault secret configured yet:
-- the guard below no-ops rather than failing the write that created the row.
--
-- FOR EACH STATEMENT, not FOR EACH ROW: `notify-fanout` claims whatever is
-- pending across the whole table regardless of which row triggered it, so
-- firing once per multi-row INSERT (a digest job, an import) is exactly as
-- effective as firing once per row and wastes nothing extra. A caller that
-- runs several separate single-row INSERT statements in one transaction still
-- fires this once per statement — redundant but harmless, since the claim
-- underneath is idempotent.

CREATE FUNCTION public.baaki_notify_fanout_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_key text;
BEGIN
  -- Never let a delivery hiccup roll back the write that created the
  -- notification — an expense, a settlement, a group-add. Whatever goes
  -- wrong here (no Vault secret yet, `pg_net` unavailable, anything else)
  -- is swallowed; the row stays in `notifications` and the cron still
  -- reaches it within five minutes regardless of what this trigger did.
  BEGIN
    SELECT decrypted_secret INTO v_key
      FROM vault.decrypted_secrets WHERE name = 'service_role_key';

    IF v_key IS NOT NULL THEN
      PERFORM net.http_post(
        url     := 'https://xvjzbpgcmotoahtqcxve.supabase.co/functions/v1/notify-fanout',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_key,
          'Content-Type',  'application/json'
        ),
        body    := '{}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NULL; -- ignored on an AFTER trigger
END
$$;

-- Not directly callable in practice — Postgres refuses to invoke a function
-- returning the `trigger` pseudo-type outside trigger context — but declared
-- the same as every other SECURITY DEFINER function here so the CI grant
-- check (and any reader) never has to know that nuance to trust the caller
-- model. No GRANT: nothing should ever call this except the trigger below.
REVOKE ALL ON FUNCTION public.baaki_notify_fanout_trigger() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER baaki_notify_fanout_on_insert
  AFTER INSERT ON public.notifications
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.baaki_notify_fanout_trigger();
