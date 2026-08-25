-- Voice cloud-STT entitlement & config plumbing (A48, Phase 1).
--
-- No external calls here — this is only the metering, entitlement and config
-- surface the later phases (the `voice-stt` and `voice-structure` edge
-- functions) build on. It ships dark: the master `voice_stt_enabled` flag is
-- off, so nothing changes until a provider key exists and the flag is turned on.
--
-- The entitlement rule is deliberately PER PERSON, not per group: unlike the
-- group "full mode" gate (baaki_group_is_paid, used by photos / receipt caps),
-- cloud STT is the individual's own capability and must not leak to a free user
-- just because a groupmate is paid. We reuse the existing per-profile check
-- `baaki_profile_is_paid` for exactly this.

-- ── Numeric knobs (admin/API-tunable via the existing app_config surface) ────
INSERT INTO public.app_config (key, value, description) VALUES
  ('voice_stt_free_seconds', 300,
     'Free cloud speech-to-text talk-time per calendar month, in seconds.'),
  ('voice_stt_max_clip_seconds', 60,
     'Hard cap on the audio length of a single cloud STT request, in seconds.'),
  ('voice_llm_schema_version', 1,
     'Version of the structured voice output contract the server emits.')
ON CONFLICT (key) DO NOTHING;

-- ── Text knobs (provider/model names — app_config.value is int-only) ─────────
-- Same trust shape as app_config / feature_flags: names are non-secret and
-- readable; only service-role writes. Secrets (provider API keys) live in the
-- edge-function environment, NEVER in this table.
CREATE TABLE IF NOT EXISTS public.service_config (
  key         text PRIMARY KEY,
  value       text,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.service_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_config_select ON public.service_config;
CREATE POLICY service_config_select ON public.service_config
  FOR SELECT USING (true);

REVOKE ALL ON public.service_config FROM anon, authenticated;
GRANT SELECT ON public.service_config TO anon, authenticated;
-- No INSERT/UPDATE/DELETE grant: writes go through service_role, which bypasses
-- RLS. The admin console edits these via a service-role connection.

INSERT INTO public.service_config (key, value, description) VALUES
  ('voice_stt_provider', 'deepgram', 'Cloud STT provider adapter: deepgram | gemini.'),
  ('voice_stt_model', '', 'Provider model id for STT (empty = provider default).'),
  ('voice_llm_provider', '', 'Managed LLM provider for voice structuring.'),
  ('voice_llm_model', '', 'Managed LLM model id for voice structuring.')
ON CONFLICT (key) DO NOTHING;

-- ── Per-person monthly usage meter ──────────────────────────────────────────
-- One row per (person, calendar month). A new month is simply a new period key,
-- so the free allowance resets with no cron. Writes are service-role only (the
-- edge function), so usage cannot be forged from a client; a person may read
-- their own row to see how much free talk-time is left.
CREATE TABLE IF NOT EXISTS public.voice_stt_usage (
  profile_id uuid    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period     text    NOT NULL,                       -- 'YYYY-MM' (UTC)
  seconds    integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, period),
  CONSTRAINT voice_stt_usage_seconds_nonneg CHECK (seconds >= 0)
);

ALTER TABLE public.voice_stt_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_stt_usage_select_own ON public.voice_stt_usage;
CREATE POLICY voice_stt_usage_select_own ON public.voice_stt_usage
  FOR SELECT USING (profile_id = public.baaki_current_profile_id());

REVOKE ALL ON public.voice_stt_usage FROM anon, authenticated;
GRANT SELECT ON public.voice_stt_usage TO authenticated;

-- ── Readers & recorders ─────────────────────────────────────────────────────

-- The monthly free allowance, in seconds, with a safe fallback if the knob row
-- is ever missing. Mirrors baaki_attachment_cap / baaki_receipt_cap.
CREATE OR REPLACE FUNCTION public.baaki_voice_stt_free_seconds()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT value FROM public.app_config WHERE key = 'voice_stt_free_seconds'), 300);
$$;

REVOKE ALL ON FUNCTION public.baaki_voice_stt_free_seconds() FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_voice_stt_free_seconds()
  TO authenticated, anon, service_role;

-- Seconds of cloud STT a profile has left this month. NULL means unlimited (a
-- paid person is never metered); otherwise max(0, free - used-this-month).
CREATE OR REPLACE FUNCTION public.baaki_voice_stt_remaining_seconds(p_profile uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_free   integer;
  v_used   integer;
BEGIN
  IF public.baaki_profile_is_paid(p_profile) THEN
    RETURN NULL; -- unlimited
  END IF;
  v_free := public.baaki_voice_stt_free_seconds();
  SELECT seconds INTO v_used
    FROM public.voice_stt_usage
   WHERE profile_id = p_profile AND period = v_period;
  RETURN GREATEST(0, v_free - COALESCE(v_used, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.baaki_voice_stt_remaining_seconds(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_voice_stt_remaining_seconds(uuid)
  TO authenticated, service_role;

-- Record used seconds for a profile in the current month, returning the new
-- monthly total. Service-role only: this is called by the metering edge
-- function after a provider transcribes, never from a client (a client that
-- could write here could zero or inflate its own usage).
CREATE OR REPLACE FUNCTION public.baaki_voice_stt_record(p_profile uuid, p_seconds integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_total  integer;
BEGIN
  IF p_seconds IS NULL OR p_seconds < 0 THEN
    RAISE EXCEPTION 'VOICE_STT_BAD_SECONDS';
  END IF;
  INSERT INTO public.voice_stt_usage (profile_id, period, seconds, updated_at)
  VALUES (p_profile, v_period, p_seconds, now())
  ON CONFLICT (profile_id, period) DO UPDATE
    SET seconds = public.voice_stt_usage.seconds + EXCLUDED.seconds,
        updated_at = now()
  RETURNING seconds INTO v_total;
  RETURN v_total;
END;
$$;

-- Explicitly strip anon/authenticated too: a default-privilege grant to those
-- roles is not removed by revoking from PUBLIC, and this must be service-role
-- only so a client cannot write its own usage.
REVOKE ALL ON FUNCTION public.baaki_voice_stt_record(uuid, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_voice_stt_record(uuid, integer) TO service_role;

-- The client-facing summary the app reads to show "X:XX of 5:00 free left" and
-- to choose the cloud vs on-device tier. Resolves the caller from the JWT, so it
-- takes no argument and cannot be asked about anyone else.
CREATE OR REPLACE FUNCTION public.baaki_my_voice_access()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
  v_period  text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_paid    boolean;
  v_free    integer;
  v_used    integer;
BEGIN
  IF v_profile IS NULL THEN
    RETURN jsonb_build_object(
      'paid', false, 'freeSeconds', 0, 'usedSeconds', 0,
      'remainingSeconds', 0, 'period', v_period);
  END IF;

  v_paid := public.baaki_profile_is_paid(v_profile);
  v_free := public.baaki_voice_stt_free_seconds();
  SELECT seconds INTO v_used
    FROM public.voice_stt_usage
   WHERE profile_id = v_profile AND period = v_period;
  v_used := COALESCE(v_used, 0);

  RETURN jsonb_build_object(
    'paid', v_paid,
    'freeSeconds', v_free,
    'usedSeconds', v_used,
    'remainingSeconds', CASE WHEN v_paid THEN NULL ELSE GREATEST(0, v_free - v_used) END,
    'period', v_period
  );
END;
$$;

REVOKE ALL ON FUNCTION public.baaki_my_voice_access() FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_my_voice_access() TO authenticated;
