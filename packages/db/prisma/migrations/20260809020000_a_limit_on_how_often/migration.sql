-- A limit on how often anybody may call the edge functions.
--
-- Two limits existed before this and both are about money rather than abuse:
-- `baaki_receipt_scan_quota` caps scans per month because a scan calls a model,
-- and `invite-mint` caps live links per group. Everything else — `sync`,
-- `expense-write`, `export-data`, `fx-rate`, `invite-accept` — could be called
-- as fast as a script can post, by anybody holding the anon key. That key ships
-- inside the mobile binary, so "anybody" is the correct word.
--
-- `invite-accept` is the one that matters most. In preview mode it looks a
-- token up and answers before any user identity is required, which makes it an
-- oracle: post enough guesses and you find a live invite to somebody's group.
-- The single-message-for-every-failure rule already stops it leaking *which*
-- guess was close; this stops the guessing being free.
--
-- Fixed windows, not a sliding log. A sliding window means keeping every hit
-- and counting them per request; a fixed window is one row and one statement.
-- The cost is that somebody can spend a full allowance at the end of one window
-- and another at the start of the next — a burst of 2× for one instant. For
-- stopping scripted abuse that is an entirely acceptable trade, and for stopping
-- a stampede the window is short enough that it self-corrects.

-- ─────────────────────────────────────────────────────────── the counter ──
--
-- `subject` is text rather than a uuid FK on purpose: most callers are a
-- profile, but `invite-accept`'s preview has no profile to blame and is keyed
-- on the client address instead. A FK would force a second table for that, and
-- rows here are disposable — they are a counter, not a record of anything.

CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  subject      text        NOT NULL,
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (subject, bucket, window_start),

  CONSTRAINT rate_limit_hits_hits_positive CHECK (hits >= 0)
);

-- For the sweep below, which is the only query that does not go through the
-- primary key.
CREATE INDEX IF NOT EXISTS rate_limit_hits_window_start_idx
  ON public.rate_limit_hits (window_start);

-- No client has any business reading or writing this. RLS is on with no policy
-- at all — not because a policy would be wrong, but because the only correct
-- policy is "nobody", and an empty policy list says that without inviting
-- somebody to add an exception to it later.
ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_hits FROM PUBLIC;
REVOKE ALL ON TABLE public.rate_limit_hits FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────── the count ──
--
-- Granted to `service_role` alone, and so callable only from an edge function.
-- This is the whole reason the subject is a parameter: a function the client
-- could call while naming its own subject is a function the client can call
-- while naming *somebody else's*, and then the limiter is a way to lock other
-- people out rather than a way to keep them honest.
--
-- One statement, so two calls racing cannot both read 59 and both write 60.
-- `ON CONFLICT ... DO UPDATE` takes a row lock, and the loser of the race sees
-- the winner's value.

CREATE OR REPLACE FUNCTION public.baaki_rate_limit(
  p_subject        text,
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window  integer;
  v_limit   integer;
  v_start   timestamptz;
  v_hits    integer;
  v_allowed boolean;
BEGIN
  IF p_subject IS NULL OR p_subject = '' OR p_bucket IS NULL OR p_bucket = '' THEN
    RAISE EXCEPTION 'baaki_rate_limit needs a subject and a bucket';
  END IF;

  -- A window of zero would divide by zero below, and a negative limit would
  -- refuse everything for ever. Both are a caller's bug; neither is worth an
  -- outage.
  v_window := GREATEST(COALESCE(p_window_seconds, 60), 1);
  v_limit  := GREATEST(COALESCE(p_limit, 0), 0);

  -- Floor the clock to the window. Every caller in the same window agrees on
  -- the same `window_start` without anybody having to store when it opened.
  v_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / v_window) * v_window
  );

  INSERT INTO public.rate_limit_hits AS existing (subject, bucket, window_start, hits)
  VALUES (p_subject, p_bucket, v_start, 1)
  ON CONFLICT (subject, bucket, window_start)
    DO UPDATE SET hits = existing.hits + 1
  RETURNING existing.hits INTO v_hits;

  v_allowed := v_hits <= v_limit;

  RETURN jsonb_build_object(
    'allowed',   v_allowed,
    'hits',      v_hits,
    'limit',     v_limit,
    'remaining', GREATEST(v_limit - v_hits, 0),
    -- Whole seconds until this window closes, which is exactly how long the
    -- caller has to wait. Zero when they were let through, so a client can send
    -- it straight to `Retry-After` without deciding anything.
    'retryAfter', CASE
                    WHEN v_allowed THEN 0
                    ELSE GREATEST(
                      ceil(extract(epoch FROM (v_start + make_interval(secs => v_window))
                                              - clock_timestamp()))::integer,
                      1
                    )
                  END,
    'resetAt',   v_start + make_interval(secs => v_window)
  );
END
$$;

REVOKE ALL ON FUNCTION public.baaki_rate_limit(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_rate_limit(text, text, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_rate_limit(text, text, integer, integer) TO service_role;

-- ───────────────────────────────────────────────────────────── the sweep ──
--
-- Windows are minutes or hours wide and rows are never read again once theirs
-- has closed, so without this the table grows for ever at the rate the app is
-- used. A day is far longer than the widest window here and leaves enough
-- behind to answer "was somebody hammering us last night".

CREATE OR REPLACE FUNCTION public.baaki_sweep_rate_limits()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.rate_limit_hits
   WHERE window_start < now() - interval '1 day';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_sweep_rate_limits() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_sweep_rate_limits() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_sweep_rate_limits() TO service_role;

-- Guarded exactly like the push fanout's schedule: CI applies these migrations
-- to bare Postgres, which has no `pg_cron`, and a migration that cannot be
-- applied there is a migration nothing tests.
DO $$
BEGIN
  PERFORM cron.unschedule('baaki-sweep-rate-limits')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'baaki-sweep-rate-limits');

  PERFORM cron.schedule(
    'baaki-sweep-rate-limits', '17 3 * * *',
    'SELECT public.baaki_sweep_rate_limits()'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'rate limit sweep not scheduled: %. Rows will accumulate until it is.', SQLERRM;
END
$$;
