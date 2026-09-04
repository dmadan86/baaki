-- `pg_net`, which the fanout cannot do without.
--
-- Two things reach for `net.http_post`: the every-five-minutes cron job, and
-- `waves_notify_fanout_trigger`, which asks the edge function to go now rather
-- than wait for the next tick. The trigger swallows its own failures (an AFTER
-- trigger that raises would take the INSERT down with it), so a missing
-- extension does not break writing a notification — it just silently stops the
-- immediate half of delivery, and leaves the cron job erroring
-- `schema "net" does not exist` on every run.
--
-- It was left out of the baseline because a schema-only dump does not carry
-- extensions the database happens to have, and on this project `pg_net` sits in
-- `public` — so rebuilding that schema takes the extension with it. Recreating
-- it belongs in the migrations, where a rebuild will run it again.
--
-- Guarded twice over: `pg_net` is a hosted-Postgres extension and is simply not
-- available on the plain Postgres that CI and a laptop run, where the fanout is
-- driven by calling the edge function directly rather than by a schedule.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_net;
  ELSE
    RAISE NOTICE 'pg_net is not available here; the scheduled fanout is hosted-only';
  END IF;
END
$$;
