-- Device sessions and the free-tier two-device cap.
--
-- GoTrue tracks refresh tokens but nothing a person would recognise as "my
-- phones": no label, no last-seen, and nothing the client may read. This table
-- is that missing thing — one row per (account, device) — written only through
-- the SECURITY DEFINER functions below so the client can register and read its
-- own devices but never forge somebody else's or lift its own cap.
--
-- The cap itself is soft on purpose (see baaki_register_device): the database
-- reports "over the line", the app asks the person to sign the others out, and
-- nothing here can ever leave an account locked out of its own data.

CREATE TABLE public.device_sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- A stable id the app keeps in the device keystore, so a token refresh does
  -- not look like a new phone. One row per (profile, device).
  device_id   text        NOT NULL,
  label       text        NOT NULL DEFAULT 'This device',
  platform    text        NOT NULL DEFAULT 'unknown',
  app_version text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Set when this device is signed out from another one. It stays in the table
  -- so the activity view can say "signed out" rather than simply forgetting it.
  revoked_at  timestamptz,
  CONSTRAINT device_sessions_one_per_device UNIQUE (profile_id, device_id)
);

CREATE INDEX device_sessions_profile_seen_idx
  ON public.device_sessions (profile_id, last_seen_at DESC);

-- Row-level security: a person may read their own devices and nothing else.
-- Every write goes through the definer functions, so no direct-write grant.
ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.device_sessions FROM anon, authenticated;
GRANT SELECT ON public.device_sessions TO authenticated;

CREATE POLICY device_sessions_own_read ON public.device_sessions
  FOR SELECT TO authenticated
  USING (profile_id = public.baaki_current_profile_id());

-- ─────────────────────────────────────────────────────────── registering ──

/**
 * Register (or refresh) the calling device, and report where the account stands
 * against its cap.
 *
 * Upsert rather than insert: the same phone opening the app again is a
 * last-seen bump, not a new device, and re-registering a phone that had been
 * signed out elsewhere brings it back (revoked_at cleared) — signing in again
 * is exactly how you undo a remote sign-out.
 *
 * The tier and the counting are decided here, never by the caller. "Active"
 * means not revoked and seen in the last 14 days, counted per device_id, so a
 * phone left in a drawer stops holding a slot on its own. The answer is a
 * report, not a verdict: this function never refuses. A free account already
 * holding two other live phones is told overLimit=true and the app takes it
 * from there.
 */
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

  v_limit := CASE WHEN v_tier = 'plus' THEN 10 ELSE 2 END;

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

-- ───────────────────────────────────────────────────────────── listing ──

/**
 * The devices activity view: the caller's phones seen in the last three months,
 * newest first, revoked ones included. Older than that is history nobody is
 * going to act on, and the request was explicit about three months.
 */
CREATE OR REPLACE FUNCTION public.baaki_list_devices()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'deviceId', device_id,
        'label', label,
        'platform', platform,
        'appVersion', app_version,
        'createdAt', created_at,
        'lastSeenAt', last_seen_at,
        'revokedAt', revoked_at
      )
      ORDER BY last_seen_at DESC
    ),
    '[]'::jsonb
  )
  FROM public.device_sessions
  WHERE profile_id = public.baaki_current_profile_id()
    AND last_seen_at > now() - interval '90 days';
$$;

GRANT EXECUTE ON FUNCTION public.baaki_list_devices() TO authenticated;

-- ────────────────────────────────────────────── signing the others out ──

/**
 * Mark every other device of the caller's revoked, and say how many.
 *
 * This is the bookkeeping half: the actual token revocation is the client
 * calling GoTrue's signOut({ scope: 'others' }), which cannot itself write this
 * table. Doing both keeps the activity view honest — the phones it now shows as
 * signed out are the same ones whose sessions were just torn down.
 */
CREATE OR REPLACE FUNCTION public.baaki_sign_out_other_devices(p_device_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
  v_count   int;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN: only a signed-in account has devices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.device_sessions
  SET revoked_at = now()
  WHERE profile_id = v_profile
    AND device_id <> p_device_id
    AND revoked_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_sign_out_other_devices(text) TO authenticated;
