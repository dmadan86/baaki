-- Voice quick-add misses, reported from the device so the parser can be improved
-- against what people actually said.
--
-- This reverses the earlier "device-only log with its own settings screen" design
-- (apps/mobile/src/lib/voiceLog.ts): a failed dictation is now sent silently to
-- the backend and surfaced in the admin console, where the team reads the
-- transcripts the parser could not understand.
--
-- Privacy shape, mirrored on `feedback`:
--   * The caller is stamped server-side from the JWT — no id is trusted from the
--     client (see baaki_log_voice_attempt below).
--   * Only admins / service_role may read: no SELECT is granted to anon or
--     authenticated, and RLS carries no SELECT policy, so nobody but the console
--     ever reads another person's speech.
--   * A row dies with its author: profile_id is ON DELETE CASCADE, so erasing an
--     account takes its transcripts with it. (feedback deliberately keeps rows on
--     deletion; there is no such reason to preserve a raw transcript, and CASCADE
--     is the more privacy-respecting choice.)
--
-- The client only ever sends unparsed attempts (item_count 0) and only with the
-- analytics opt-in; the column is stored as sent so the console reflects what the
-- device actually saw.

--
-- Name: voice_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid,
    transcript text NOT NULL,
    locale text,
    used_model boolean DEFAULT false NOT NULL,
    item_count integer DEFAULT 0 NOT NULL,
    platform text,
    app_version text,
    -- The device's own clock when the miss happened. Kept alongside the
    -- server-assigned created_at because a report can arrive later than the
    -- moment it describes.
    client_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_attempts_item_count_nonneg CHECK ((item_count >= 0)),
    CONSTRAINT voice_attempts_transcript_present CHECK (((length(TRIM(BOTH FROM transcript)) >= 1) AND (length(TRIM(BOTH FROM transcript)) <= 4000)))
);

--
-- Name: voice_attempts voice_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_attempts
    ADD CONSTRAINT voice_attempts_pkey PRIMARY KEY (id);

--
-- Name: voice_attempts voice_attempts_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_attempts
    ADD CONSTRAINT voice_attempts_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: voice_attempts_recent_idx; Type: INDEX; Schema: public; Owner: -
--
-- The console reads newest-first; this keeps that ordering cheap.

CREATE INDEX voice_attempts_recent_idx ON public.voice_attempts USING btree (created_at DESC);

--
-- Name: baaki_log_voice_attempt(text, text, boolean, integer, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--
-- Record one miss. SECURITY DEFINER so it can write a table nobody but the
-- console may read; the author is resolved from the JWT rather than trusted from
-- the caller. Best-effort by design: with no signed-in profile, or an empty
-- transcript, it returns NULL quietly rather than raising — the client fires this
-- and forgets it, and a miss that cannot be attributed is simply not stored.

CREATE FUNCTION public.baaki_log_voice_attempt(p_transcript text, p_locale text DEFAULT NULL::text, p_used_model boolean DEFAULT false, p_item_count integer DEFAULT 0, p_platform text DEFAULT NULL::text, p_app_version text DEFAULT NULL::text, p_client_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
  v_transcript text := left(trim(COALESCE(p_transcript, '')), 4000);
  v_id uuid;
BEGIN
  -- No session, or nothing to log: say nothing. This is a fire-and-forget
  -- reporter, so a null return is the quiet "not stored" the client expects.
  IF v_profile IS NULL OR length(v_transcript) = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.voice_attempts
    (profile_id, transcript, locale, used_model, item_count, platform, app_version, client_at)
  VALUES
    (v_profile, v_transcript, p_locale, COALESCE(p_used_model, false),
     GREATEST(COALESCE(p_item_count, 0), 0), p_platform, p_app_version, p_client_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

--
-- Name: baaki_admin_voice_attempts(integer); Type: FUNCTION; Schema: public; Owner: -
--
-- The console's read. Unlike baaki_admin_feedback, this returns profile_id: a
-- transcript is only useful for improving parsing if the team can follow up with
-- the person who spoke it. Granted to service_role alone (below), so this
-- reference never leaves the admin app.

CREATE FUNCTION public.baaki_admin_voice_attempts(p_limit integer DEFAULT 100) RETURNS TABLE(id uuid, profile_id uuid, transcript text, locale text, used_model boolean, item_count integer, platform text, app_version text, client_at timestamp with time zone, created_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    v.id, v.profile_id, v.transcript, v.locale, v.used_model, v.item_count,
    v.platform, v.app_version, v.client_at, v.created_at
  FROM public.voice_attempts v
  ORDER BY v.created_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 100), 1);
$$;

--
-- Name: voice_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_attempts voice_attempts_insert_own; Type: POLICY; Schema: public; Owner: -
--
-- A signed-in user may write their own miss (the RPC does exactly this). There
-- is deliberately no SELECT policy: reads are the console's alone, which reaches
-- the table as service_role and so bypasses RLS.

CREATE POLICY voice_attempts_insert_own ON public.voice_attempts FOR INSERT TO authenticated WITH CHECK ((profile_id = public.baaki_current_profile_id()));

--
-- Table grants. Supabase's default privileges can hand new public tables to
-- anon/authenticated, so the boundary is set explicitly: authenticated may only
-- INSERT (its own row, per the policy above), and service_role — the console —
-- gets the rest. No SELECT for anyone but service_role.
--

REVOKE ALL ON TABLE public.voice_attempts FROM anon;
REVOKE ALL ON TABLE public.voice_attempts FROM authenticated;
GRANT INSERT ON TABLE public.voice_attempts TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.voice_attempts TO service_role;

--
-- Function grants. Postgres gives EXECUTE to PUBLIC on every new function, and
-- anon/authenticated inherit PUBLIC in Supabase — so each is revoked first, then
-- granted to exactly who should call it.
--

REVOKE ALL ON FUNCTION public.baaki_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.baaki_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.baaki_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_admin_voice_attempts(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.baaki_admin_voice_attempts(p_limit integer) TO service_role;
