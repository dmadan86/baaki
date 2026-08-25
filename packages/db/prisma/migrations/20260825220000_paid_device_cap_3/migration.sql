-- Paid device cap: three, not ten.
--
-- An account signed in on ten phones is a shared password, not a subscriber.
-- Three covers a phone, a tablet, and a spare — generous enough never to nag,
-- tight enough to mean something. Free stays at two. Still a soft cap: the RPC
-- reports overLimit but never refuses a registration.
--
-- Only line that changes from 20260809120000_device_sessions is the paid limit
-- (10 -> 3); the rest of the body is replicated verbatim so CREATE OR REPLACE
-- swaps the whole function atomically.

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

  v_limit := CASE WHEN v_tier = 'plus' THEN 3 ELSE 2 END;

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
