-- ============================================================================
-- Rate limiting becomes something the console can see and turn.
--
-- Until now every allowance lived in `_shared/rateLimit.ts` as a constant, and
-- the only way to loosen one during an incident — or switch the whole thing off
-- to let a support engineer replay a stuck queue — was a deploy. This adds two
-- small config tables and teaches `baaki_rate_limit` to read them, so the same
-- numbers can be edited from the admin panel and take effect on the next call.
--
-- The code constants stay as the fallback: a bucket with no row here is limited
-- exactly as before. Nothing about the counting changes; only where the limit
-- and the on/off come from.
-- ============================================================================

-- ─────────────────────────────────────────── the master switch (one row) ──
-- A single boolean, in a table pinned to one row by a CHECK on the primary key,
-- so "rate limiting is off" is one fact in one place rather than a column that
-- has to be set on every bucket.
CREATE TABLE IF NOT EXISTS public.rate_limit_settings (
  id         boolean     PRIMARY KEY DEFAULT true,
  enabled    boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_limit_settings_singleton CHECK (id)
);

INSERT INTO public.rate_limit_settings (id, enabled) VALUES (true, true)
  ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────── per-bucket overrides ──
-- One row per bucket. `enabled` off exempts just that bucket; `max_calls` and
-- `window_seconds` override the code defaults when the row is present.
CREATE TABLE IF NOT EXISTS public.rate_limit_rules (
  bucket         text        PRIMARY KEY,
  enabled        boolean     NOT NULL DEFAULT true,
  max_calls      integer     NOT NULL,
  window_seconds integer     NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_limit_rules_max_calls_nonneg CHECK (max_calls >= 0),
  CONSTRAINT rate_limit_rules_window_positive  CHECK (window_seconds >= 1)
);

-- Seed the buckets that exist today with their current values, so the console
-- opens on the real configuration rather than a blank page. Kept in step with
-- `LIMITS` in `supabase/functions/_shared/rateLimit.ts`.
INSERT INTO public.rate_limit_rules (bucket, enabled, max_calls, window_seconds) VALUES
  ('sync',           true, 120,  60),
  ('expense-write',  true,  60,  60),
  ('export-data',    true,  10, 3600),
  ('fx-rate',        true,  60,  60),
  ('invite-mint',    true,  30, 3600),
  ('invite-accept',  true,  30, 3600),
  ('receipt-parse',  true,  10,  60)
ON CONFLICT (bucket) DO NOTHING;

-- ───────────────────────────────────────────────────────── locked down ──
-- Config, not data: readable and writable by the service role alone. The RPC
-- below is SECURITY DEFINER and reads these regardless of RLS; no client ever
-- touches them, exactly like `feature_flags` write access.
ALTER TABLE public.rate_limit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_rules    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_settings FROM PUBLIC;
REVOKE ALL ON TABLE public.rate_limit_settings FROM anon, authenticated;
REVOKE ALL ON TABLE public.rate_limit_rules    FROM PUBLIC;
REVOKE ALL ON TABLE public.rate_limit_rules    FROM anon, authenticated;
GRANT SELECT, UPDATE          ON TABLE public.rate_limit_settings TO service_role;
GRANT SELECT, INSERT, UPDATE  ON TABLE public.rate_limit_rules    TO service_role;

-- ─────────────────────────────── the limiter now consults the config ──
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
  v_window       integer;
  v_limit        integer;
  v_start        timestamptz;
  v_hits         integer;
  v_allowed      boolean;
  v_master       boolean;
  v_rule_enabled boolean;
  v_rule_calls   integer;
  v_rule_window  integer;
BEGIN
  IF p_subject IS NULL OR p_subject = '' OR p_bucket IS NULL OR p_bucket = '' THEN
    RAISE EXCEPTION 'baaki_rate_limit needs a subject and a bucket';
  END IF;

  -- Master off, or this bucket switched off: let it straight through. Nothing is
  -- counted, so turning the limit back on starts from a clean window rather than
  -- from whatever piled up while it was off.
  SELECT enabled INTO v_master FROM public.rate_limit_settings WHERE id = true;
  IF v_master IS NOT NULL AND NOT v_master THEN
    RETURN jsonb_build_object(
      'allowed', true, 'hits', 0, 'limit', 0,
      'remaining', 2147483647, 'retryAfter', 0, 'resetAt', clock_timestamp()
    );
  END IF;

  -- The code default is the fallback; a row for this bucket overrides it.
  v_window := GREATEST(COALESCE(p_window_seconds, 60), 1);
  v_limit  := GREATEST(COALESCE(p_limit, 0), 0);

  SELECT enabled, max_calls, window_seconds
    INTO v_rule_enabled, v_rule_calls, v_rule_window
    FROM public.rate_limit_rules
   WHERE bucket = p_bucket;

  IF FOUND THEN
    IF NOT v_rule_enabled THEN
      RETURN jsonb_build_object(
        'allowed', true, 'hits', 0, 'limit', 0,
        'remaining', 2147483647, 'retryAfter', 0, 'resetAt', clock_timestamp()
      );
    END IF;
    v_limit  := GREATEST(v_rule_calls, 0);
    v_window := GREATEST(v_rule_window, 1);
  END IF;

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
