-- The other half of A21: a campaign that also goes out by email (TDR §7, §7.3).
--
-- The in-app half already exists — `baaki_my_campaign` shows the targeted cohort
-- an announcement once, inside the lock screen, and records that they saw it.
-- What was missing is the product being able to reach the same people in their
-- inbox, which is the only way to say anything to somebody who has not opened
-- the app since the campaign started.
--
-- It is built the same way the notification email half was, and reuses its
-- machinery rather than growing a parallel one:
--
--   * the address, the suppression list and the confirmed-email rule are
--     `baaki_email_for` and `baaki_email_suppressed`, unchanged;
--   * a `sent` row lands in `email_events` exactly as a notification's does, so
--     the existing `email-events` webhook suppresses a campaign that bounces or
--     draws a complaint with no new code;
--   * claiming is an INSERT whose UNIQUE(campaign_id, profile_id) is the lock,
--     so two overlapping runs cannot mail the same person twice.
--
-- The one rule this half adds is the one the whole campaign feature turns on:
-- **the holdout is never mailed.** A holdout who receives the announcement has
-- stopped being a control group, and every revenue number downstream of that is
-- decoration. The cohort filter here is the same `baaki_campaign_cohort` the
-- in-app half uses, so the two can never disagree about who is held out.
--
-- Nothing here is reachable by a signed-in user. Every function reads addresses
-- and cohorts, which is the service role's business and no one else's.

-- ─────────────────────────────────────────────────────── who was mailed ──
-- One row per person per campaign. The row is the claim: it is written 'queued'
-- the moment somebody is picked, and the UNIQUE constraint means a second run
-- that races the first loses the insert rather than sending a second copy.
--
-- Keyed on the profile, not the address, because that is what the cohort and the
-- dedup are about — the same mailbox reused by a different account later is a
-- different person for this purpose, and the suppression list (keyed on the
-- address) is the thing that outlives the account.

CREATE TABLE IF NOT EXISTS public.campaign_email_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  profile_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- The address as it was at claim time, lower-cased. Kept on the row so the
  -- webhook and any later audit can see who a Resend id was for without another
  -- reach into auth.users.
  address         text NOT NULL,
  -- queued → the claim is held; sent → Resend accepted it; failed → it refused
  -- permanently. A transient refusal is not a status: the row is deleted so the
  -- next run re-picks the person (see baaki_finish_campaign_emails).
  status          text NOT NULL DEFAULT 'queued',
  resend_email_id text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaign_email_sends_once UNIQUE (campaign_id, profile_id),
  CONSTRAINT campaign_email_sends_status_known
    CHECK (status IN ('queued', 'sent', 'failed')),
  CONSTRAINT campaign_email_sends_address_present CHECK (address <> '')
);

CREATE INDEX IF NOT EXISTS campaign_email_sends_campaign_idx
  ON public.campaign_email_sends (campaign_id, status);

ALTER TABLE public.campaign_email_sends ENABLE ROW LEVEL SECURITY;

-- No client-readable policy. A row here says who was mailed and, by absence,
-- who was held out — the one fact the whole campaign design keeps from the
-- client. The service role reaches it through the functions below and nobody
-- else reaches it at all.
REVOKE ALL ON TABLE public.campaign_email_sends FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.campaign_email_sends FROM anon, authenticated;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────── claiming ──
-- Picks a bounded batch of people who should be mailed and have not been, marks
-- them queued, and hands the edge function the address and the words to send.
--
-- The eligibility is the in-app audience minus everyone email cannot or must not
-- reach: no confirmed address, email turned off in prefs, on the suppression
-- list, or held out. Held out is checked with the same function the in-app half
-- uses, so the arms can never drift apart.

CREATE OR REPLACE FUNCTION public.baaki_claim_campaign_emails(
  p_campaign_id uuid,
  p_limit       integer DEFAULT 100
)
RETURNS TABLE (
  send_id    uuid,
  address    text,
  locale     text,
  title      text,
  body       text,
  cta_label  text,
  promo_code text,
  ends_at    timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- The OUT columns (address, title, body, …) share names with columns of the
-- tables joined below. RETURN QUERY matches by position, not name, so prefer the
-- column every time rather than have a qualified reference read as an OUT
-- variable and raise "column reference is ambiguous".
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH c AS (
    SELECT * FROM public.campaigns WHERE id = p_campaign_id
  ),
  eligible AS (
    SELECT p.id AS profile_id
    FROM public.profiles p
    CROSS JOIN c
    -- Only while the campaign is live. A send before it starts or after it ends
    -- is a send the funnel cannot attribute, so it is not allowed to happen.
    WHERE now() BETWEEN c.starts_at AND c.ends_at
      AND (c.audience_countries IS NULL OR p.country_code = ANY (c.audience_countries))
      AND public.baaki_campaign_cohort(c.id, p.id) = 'targeted'
      AND COALESCE((p.notification_prefs ->> 'email')::boolean, TRUE)
      AND public.baaki_email_for(p.id) IS NOT NULL
      AND NOT public.baaki_email_suppressed(public.baaki_email_for(p.id))
      AND NOT EXISTS (
        SELECT 1 FROM public.campaign_email_sends s
        WHERE s.campaign_id = c.id AND s.profile_id = p.id
      )
    LIMIT p_limit
  ),
  claimed AS (
    INSERT INTO public.campaign_email_sends (campaign_id, profile_id, address, status)
    SELECT p_campaign_id, e.profile_id, public.baaki_email_for(e.profile_id), 'queued'
    FROM eligible e
    ON CONFLICT (campaign_id, profile_id) DO NOTHING
    RETURNING id, profile_id, address
  )
  SELECT cl.id, cl.address, COALESCE(p.locale, 'en'),
         c.title, c.body, c.cta_label, c.promo_code, c.ends_at
  FROM claimed cl
  JOIN public.profiles p ON p.id = cl.profile_id
  CROSS JOIN c;
END
$$;

-- ────────────────────────────────────────────────────────── finishing ──
-- Records what Resend said, one JSON array rather than parallel arrays so each
-- id carries its own status and its own Resend id.
--
-- 'retry' deletes the claim instead of storing it: a network throw never reached
-- Resend and a 429/5xx was declined, so in both cases nothing was sent and the
-- next run should try the person again. The row carries no Resend id yet, so
-- dropping it loses nothing, and the send's Idempotency-Key covers the one case
-- where Resend accepted before the connection dropped.
--
-- A 'sent' also writes the same `email_events` row a notification send writes,
-- with a NULL notification_id. That is what lets the existing signature-verified
-- `email-events` webhook match a bounce or complaint back to this person and
-- suppress the address — the campaign half needs no webhook of its own.

CREATE OR REPLACE FUNCTION public.baaki_finish_campaign_emails(p_results jsonb DEFAULT '[]'::jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row    jsonb;
  v_id     uuid;
  v_status text;
  v_count  integer := 0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_results, '[]'::jsonb))
  LOOP
    v_id := (v_row ->> 'id')::uuid;
    v_status := COALESCE(v_row ->> 'status', 'failed');

    IF v_status = 'retry' THEN
      DELETE FROM public.campaign_email_sends WHERE id = v_id;
    ELSIF v_status = 'sent' THEN
      UPDATE public.campaign_email_sends
         SET status = 'sent',
             resend_email_id = v_row ->> 'resend_email_id',
             error = NULL,
             updated_at = now()
       WHERE id = v_id;

      INSERT INTO public.email_events
        (notification_id, profile_id, resend_email_id, template, event, payload)
      SELECT NULL, s.profile_id, v_row ->> 'resend_email_id', 'campaign', 'sent', '{}'::jsonb
      FROM public.campaign_email_sends s
      WHERE s.id = v_id;
    ELSE
      UPDATE public.campaign_email_sends
         SET status = 'failed',
             error = v_row ->> 'error',
             updated_at = now()
       WHERE id = v_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

-- ──────────────────────────────────────────────────── how it is going ──
-- A count per status for the console, so "Send email" can report what it did
-- and a second press can see there is nothing left to send.

CREATE OR REPLACE FUNCTION public.baaki_admin_campaign_email_stats(p_campaign_id uuid)
RETURNS TABLE (status text, count bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT s.status, count(*)::bigint
  FROM public.campaign_email_sends s
  WHERE s.campaign_id = p_campaign_id
  GROUP BY s.status
  ORDER BY s.status;
$$;

-- ──────────────────────────────────────────────────────────── grants ──

REVOKE ALL ON FUNCTION public.baaki_claim_campaign_emails(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_finish_campaign_emails(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_campaign_email_stats(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.baaki_claim_campaign_emails(uuid, integer) FROM anon, authenticated;
    REVOKE ALL ON FUNCTION public.baaki_finish_campaign_emails(jsonb) FROM anon, authenticated;
    REVOKE ALL ON FUNCTION public.baaki_admin_campaign_email_stats(uuid) FROM anon, authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.baaki_claim_campaign_emails(uuid, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.baaki_finish_campaign_emails(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.baaki_admin_campaign_email_stats(uuid) TO service_role;
  END IF;
END
$$;
