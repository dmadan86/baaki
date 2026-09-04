-- The instant fanout poke, pointed at whatever project it is running in.
--
-- `waves_notify_fanout_trigger` carried the functions host as a literal, so the
-- baseline shipped one project's ref to every database built from it. Restoring
-- the schema into a second project (the ap-south-1 rebuild) left the trigger
-- POSTing at the *old* project: rejected there for a key it does not know, and
-- swallowed here by the same `EXCEPTION WHEN OTHERS` that protects the write.
-- Nothing surfaced. Notifications still went out, because the five-minute cron
-- carries them, so the only visible symptom was latency nobody could explain.
--
-- Two changes. The host now comes from the vault beside the key that
-- authenticates to it, because a value that differs per deployment is
-- configuration, not schema. And the poke sends `apikey` as well as
-- `Authorization`: the functions gateway authenticates on `apikey`, and a
-- request carrying only a bearer is refused before the function is entered.
--
-- Absent the secret the trigger does nothing at all, which is the honest
-- default — a fresh database has no functions host until someone deploys one,
-- and the cron still reaches every queued row within five minutes.

CREATE OR REPLACE FUNCTION public.waves_notify_fanout_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_key text;
  v_url text;
BEGIN
  -- Never let a delivery hiccup roll back the write that created the
  -- notification — an expense, a settlement, a group-add. Whatever goes
  -- wrong here (no Vault secret yet, `pg_net` unavailable, anything else)
  -- is swallowed; the row stays in `notifications` and the cron still
  -- reaches it within five minutes regardless of what this trigger did.
  BEGIN
    SELECT decrypted_secret INTO v_key
      FROM vault.decrypted_secrets WHERE name = 'service_role_key';
    SELECT decrypted_secret INTO v_url
      FROM vault.decrypted_secrets WHERE name = 'functions_base_url';

    IF v_key IS NOT NULL AND v_url IS NOT NULL THEN
      PERFORM net.http_post(
        url     := rtrim(v_url, '/') || '/notify-fanout',
        headers := jsonb_build_object(
          -- The gateway reads `apikey`; the function itself reads the bearer.
          'apikey',        v_key,
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
