-- The device cap becomes a knob the console turns, and an experiment it runs.
--
-- Until now the paid/free device limits were two integer literals baked into
-- baaki_register_device (and a matching pair in @waves/core, kept only as a
-- display fallback). Changing either meant a migration and a native release.
-- The request: let an operator set the numbers, and A/B-test them, with no
-- deploy.
--
-- Two mechanisms, layered:
--
--   1. `app_config` knobs — `device_cap_free` (2) and `device_cap_plus` (3) —
--      the baseline everybody gets, editable from the /config console page the
--      receipt cap already uses. This is the number for anyone the experiment
--      does not touch.
--
--   2. `feature_flags` experiments — `device_cap_free_ab` and
--      `device_cap_plus_ab` — whose *arm names are the numbers*. An enrolled
--      person's arm ("3", "5", …) is their cap; the same FNV-1a bucket the app
--      and console already share decides who is enrolled and which arm, with no
--      stored assignment (ADR-005). Seeded disabled at 0% so they sit in the
--      console ready to configure and change nothing until an operator turns
--      them on.
--
-- NOTE — this deliberately reverses an aside in 20260818160000_receipt_cap,
-- which said a flag "answers on/off and which A/B arm, never 'how many', and
-- the server could not read a limit out of an arm name cleanly." That held for
-- a static per-group cap. Here the number *is* the thing under experiment, so
-- the arm must carry it — and the read is made clean by validating the arm is a
-- bare non-negative integer (`^[0-9]+$`) and falling back to the knob for any
-- arm that is not. A flag reused for something non-numeric cannot corrupt a cap.
--
-- The server stays authoritative: baaki_register_device returns the resolved
-- limit and `overLimit`, and the phone renders whatever it is handed. The cap
-- stays soft — the RPC reports over-limit, it never refuses a registration.

-- ─────────────────────────────────────────────────── the knobs ──

INSERT INTO public.app_config (key, value, description)
VALUES
  ('device_cap_free', 2, 'Devices a free account may sign in on at once before the soft over-limit gate appears.'),
  ('device_cap_plus', 3, 'Devices a paid (Plus) account may sign in on at once before the soft over-limit gate appears.')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────── the experiments ──
-- Seeded disabled: with enabled=false, baaki_variant returns NULL for everyone,
-- so the cap resolves to the knob until an operator enables one. Arms are the
-- candidate numbers; the first is the current baseline by convention.

INSERT INTO public.feature_flags (key, description, enabled, rollout_percent, variants)
VALUES
  ('device_cap_free_ab', 'Experiment on the free device cap. Arms are the number of devices; enrolled accounts get their arm instead of the device_cap_free knob.', false, 0, ARRAY['2', '3']),
  ('device_cap_plus_ab', 'Experiment on the paid device cap. Arms are the number of devices; enrolled accounts get their arm instead of the device_cap_plus knob.', false, 0, ARRAY['3', '5'])
ON CONFLICT (key) DO NOTHING;

-- ──────────────────────────────────────── resolving one cap ──

/**
 * The device cap for one account: experiment arm if enrolled and numeric,
 * otherwise the knob, otherwise a hardcoded floor.
 *
 * Order matters. The experiment wins over the knob for the people it enrolls —
 * that is what running it means — but only when the arm is a clean non-negative
 * integer; any other arm (a flag repurposed, a typo) is ignored in favour of
 * the knob, so a misconfigured experiment degrades to the baseline rather than
 * to nonsense. The knob's own COALESCE floor covers a project the seed never
 * reached, so a missing row is generous (2/3), never a lockout at zero.
 *
 * STABLE and INVOKER: it reads only public configuration (app_config,
 * feature_flags), which every role may already see. Called from the DEFINER
 * baaki_register_device, it runs with that context's read of those same public
 * tables — nothing here needs elevation.
 */
CREATE OR REPLACE FUNCTION public.baaki_device_cap(p_profile_id uuid, p_is_plus boolean)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_knob_key text := CASE WHEN p_is_plus THEN 'device_cap_plus' ELSE 'device_cap_free' END;
  v_flag_key text := CASE WHEN p_is_plus THEN 'device_cap_plus_ab' ELSE 'device_cap_free_ab' END;
  v_floor    int  := CASE WHEN p_is_plus THEN 3 ELSE 2 END;
  v_arm      text;
BEGIN
  IF p_profile_id IS NOT NULL THEN
    v_arm := public.baaki_variant(v_flag_key, p_profile_id);
    IF v_arm ~ '^[0-9]+$' THEN
      RETURN v_arm::int;
    END IF;
  END IF;

  RETURN COALESCE((SELECT value FROM public.app_config WHERE key = v_knob_key), v_floor);
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_device_cap(uuid, boolean) TO authenticated, service_role;

-- ─────────────────────────────── the cap, wired into registration ──
-- CREATE OR REPLACE of 20260809120000_device_sessions' function; the only change
-- from that body is the v_limit line, which now resolves through the knob and
-- the experiment instead of a literal CASE. The rest is replicated verbatim so
-- the whole function swaps atomically.

CREATE OR REPLACE FUNCTION public.baaki_register_device(
  p_device_id   text,
  p_label       text DEFAULT 'This device',
  p_platform    text DEFAULT 'unknown',
  p_app_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
  v_tier    text := public.baaki_my_plan() ->> 'tier';
  v_limit   int;
  v_active  int;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN: only a signed-in account has devices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_device_id IS NULL OR length(trim(p_device_id)) = 0 THEN
    RAISE EXCEPTION 'BAD_DEVICE_ID: a device id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.device_sessions
    (profile_id, device_id, label, platform, app_version, last_seen_at, revoked_at)
  VALUES
    (v_profile, p_device_id, COALESCE(NULLIF(trim(p_label), ''), 'This device'),
     COALESCE(NULLIF(trim(p_platform), ''), 'unknown'), p_app_version, now(), NULL)
  ON CONFLICT (profile_id, device_id) DO UPDATE
    SET label        = EXCLUDED.label,
        platform     = EXCLUDED.platform,
        app_version  = EXCLUDED.app_version,
        last_seen_at = now(),
        revoked_at   = NULL;

  v_limit := public.baaki_device_cap(v_profile, v_tier = 'plus');

  SELECT count(*) INTO v_active
  FROM public.device_sessions
  WHERE profile_id = v_profile
    AND revoked_at IS NULL
    AND last_seen_at > now() - interval '14 days';

  RETURN jsonb_build_object(
    'tier', v_tier,
    'limit', v_limit,
    'activeCount', v_active,
    'overLimit', v_active > v_limit
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_register_device(text, text, text, text) TO authenticated;
