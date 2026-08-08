-- The other half of the notification pipeline (TDR §7.3).
--
-- Push has been able to reach a phone since M4 opened. Email had a column in
-- the schema and nothing else: no sender, no webhook, no way for anybody to
-- make it stop. This is the missing half, and it is built the same way the push
-- half was — the claiming, the deciding and the suppressing live here in SQL,
-- and the edge function is left with fetch, render, send, record.
--
--   1. an address for a profile, without assuming Supabase is underneath
--   2. the suppression list — the one thing that must be right
--   3. claiming (an UPDATE, so two runs cannot mail the same thing twice)
--   4. finishing, with Resend's id kept for the webhook to match against
--   5. ingesting what the webhook says, and suppressing on the strength of it
--
-- Nothing here is reachable by a signed-in user. Every function reads or writes
-- somebody else's mail; that is the service role's business and no one else's.

-- ────────────────────────────────────────────────── 0. a status for it ──
-- 'failed' would be a lie for a notification we chose not to mail. A person who
-- unsubscribed, or who has no address, is not a delivery that went wrong, and
-- recording it as one turns the failure rate into a number nobody can read.
ALTER TYPE public."DeliveryStatus" ADD VALUE IF NOT EXISTS 'suppressed';

-- ───────────────────────────────────────────────────── 1. the address ──
-- Addresses live in `auth.users`, which belongs to Supabase and does not exist
-- on the bare Postgres CI runs against. Guarded and executed dynamically so the
-- same migration applies to both: no auth schema means no address, which means
-- no email, which is exactly the right behaviour on a database that has no
-- users in it.
--
-- Unconfirmed addresses are skipped. Somebody typed it; until they have proved
-- they read it, mailing it is mailing a stranger.

CREATE OR REPLACE FUNCTION public.baaki_email_for(p_profile_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email text;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE $q$
    SELECT lower(u.email)
    FROM auth.users u
    WHERE u.id = $1
      AND u.email IS NOT NULL
      AND u.email <> ''
      AND u.email_confirmed_at IS NOT NULL
  $q$
  INTO v_email
  USING p_profile_id;

  RETURN v_email;
END
$$;

-- ────────────────────────────────────────────── 2. the suppression list ──
-- A hard bounce, a spam complaint, or somebody clicking the one-click
-- unsubscribe. All three mean the same thing operationally — do not mail this
-- address again — and keeping them in one table means the check before every
-- send is one lookup rather than three.
--
-- Keyed on the address rather than the profile on purpose. A complaint is made
-- by a mailbox, not by an account, and the same mailbox may later belong to a
-- different profile. The mailbox's answer outlives the account.

CREATE TABLE IF NOT EXISTS public.email_suppressions (
  address    text        PRIMARY KEY,
  reason     text        NOT NULL,
  /** Whatever the provider said, kept verbatim for when the reason is argued. */
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_suppressions_reason_known
    CHECK (reason IN ('bounced', 'complained', 'unsubscribed')),
  -- Stored lower-cased, so the lookup before a send never has to guess how the
  -- address was typed the day it was written.
  CONSTRAINT email_suppressions_address_normalised
    CHECK (address = lower(address) AND address <> '')
);

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.email_suppressions FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.email_suppressions FROM anon, authenticated;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_suppress_email(
  p_address text,
  p_reason  text,
  p_detail  jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_address text := lower(trim(COALESCE(p_address, '')));
BEGIN
  IF v_address = '' THEN
    RETURN FALSE;
  END IF;

  -- First reason wins. An address that hard-bounced and later gets an
  -- unsubscribe is still suppressed for the bounce, and that is the reason
  -- worth keeping.
  INSERT INTO public.email_suppressions (address, reason, detail)
  VALUES (v_address, p_reason, COALESCE(p_detail, '{}'::jsonb))
  ON CONFLICT (address) DO NOTHING;

  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_email_suppressed(p_address text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_suppressions
    WHERE address = lower(trim(COALESCE(p_address, '')))
  );
$$;

-- ─────────────────────────────────────────────────────── 3. claiming ──
-- The same shape as `baaki_claim_push_notifications`, and for the same reason:
-- a job that reads rows and then sends them sends twice the moment two runs
-- overlap. The claim is an UPDATE.
--
-- What is emailable is decided here rather than in the edge function. The list
-- is short by design (ADR-010, TDR §7.3) — routine expense activity is the
-- inbox's job. Mailing it is the habit that trains people to filter the sender,
-- and a list held in SQL cannot be widened by a deploy that forgot why.

CREATE OR REPLACE FUNCTION public.baaki_claim_email_notifications(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
  id         UUID,
  kind       TEXT,
  title      TEXT,
  body       TEXT,
  deep_link  TEXT,
  payload    JSONB,
  locale     TEXT,
  address    TEXT,
  group_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  WITH picked AS (
    SELECT n.id
    FROM public.notifications n
    WHERE n.email_status IS NULL
      -- Same two days as push. A mail about a reminder from Tuesday is worse
      -- than no mail, and a backlog that never expires is a backlog that will
      -- one day all go out at once.
      AND n.created_at > now() - interval '2 days'
      AND n.kind IN ('settlement_initiated', 'settlement_confirm_request', 'digest_daily', 'nudge')
    ORDER BY n.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.notifications n
       SET email_status = 'queued'
      FROM picked
     WHERE n.id = picked.id
    RETURNING n.id
  )
  SELECT COALESCE(array_agg(claimed.id), '{}') INTO v_ids FROM claimed;

  -- Separate statements, because Postgres will not apply two updates to the
  -- same row inside one statement — folding these into the CTE above would
  -- silently do nothing at all.

  -- No address, no confirmed address, or the person turned email off. Not a
  -- failure; a decision, and marked as one so it never gets retried.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND (
       public.baaki_email_for(n.profile_id) IS NULL
       OR NOT COALESCE(
            (SELECT (p.notification_prefs ->> 'email')::boolean
             FROM public.profiles p WHERE p.id = n.profile_id),
            TRUE
          )
     );

  -- The mailbox already said no, by bouncing, complaining or unsubscribing.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND n.email_status = 'queued'
     AND public.baaki_email_suppressed(public.baaki_email_for(n.profile_id));

  -- TDR §7.4: a nudge goes by email only to somebody with no live device.
  -- Everybody else already got a buzz about it, and a second copy in their
  -- mailbox is the thing that makes a friendly reminder feel like dunning.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND n.email_status = 'queued'
     AND n.kind = 'nudge'
     AND EXISTS (
       SELECT 1 FROM public.push_tokens t
       WHERE t.profile_id = n.profile_id AND t.revoked_at IS NULL
     );

  RETURN QUERY
  SELECT n.id, n.kind, n.title, n.body, n.deep_link, n.payload,
         COALESCE(p.locale, 'en'),
         public.baaki_email_for(n.profile_id),
         g.name
  FROM public.notifications n
  LEFT JOIN public.profiles p ON p.id = n.profile_id
  LEFT JOIN public.groups g ON g.id = n.group_id
  WHERE n.id = ANY(v_ids) AND n.email_status = 'queued';
END
$$;

-- ────────────────────────────────────────────────────── 4. finishing ──
-- Takes one JSON array rather than parallel arrays, because each result carries
-- Resend's id and the template alongside the status, and three arrays that have
-- to stay index-aligned is a bug waiting for a partial failure.
--
-- 'sent' rather than 'delivered', for the same reason the push half says it:
-- Resend accepting a message is all this layer can know. Whether it landed in
-- an inbox or a spam folder arrives later, on the webhook.

CREATE OR REPLACE FUNCTION public.baaki_finish_email(p_results jsonb DEFAULT '[]'::jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     jsonb;
  v_id      uuid;
  v_status  text;
  v_count   integer := 0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_results, '[]'::jsonb))
  LOOP
    v_id := (v_row ->> 'id')::uuid;
    v_status := COALESCE(v_row ->> 'status', 'failed');
    IF v_status NOT IN ('sent', 'failed', 'retry') THEN
      v_status := 'failed';
    END IF;

    IF v_status = 'retry' THEN
      -- Back to unclaimed. Resend being rate-limited or briefly down is not a
      -- reason to lose a settlement confirmation; the next run picks it up, and
      -- the two-day window in the claim is what stops it retrying forever.
      UPDATE public.notifications SET email_status = NULL WHERE id = v_id;
    ELSE
      UPDATE public.notifications
         SET email_status = v_status::public."DeliveryStatus"
       WHERE id = v_id;
    END IF;

    -- The send itself is an event. Without this row the webhook has nothing to
    -- match its `delivered` and `bounced` reports against — Resend reports an
    -- email id, and this is the only place that id is ever written down.
    IF v_status = 'sent' THEN
      INSERT INTO public.email_events
        (notification_id, profile_id, resend_email_id, template, event, payload)
      SELECT n.id, n.profile_id, v_row ->> 'resend_email_id',
             COALESCE(v_row ->> 'template', 'unknown'), 'sent', '{}'::jsonb
      FROM public.notifications n
      WHERE n.id = v_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

-- ──────────────────────────────────────────── 5. what the webhook says ──
-- Resend reports against its own email id. Matching it back to a person goes
-- through the `sent` row written above; an event for an id we never sent is
-- recorded against nobody rather than dropped, because a webhook arriving for
-- an unknown id is worth being able to see.
--
-- A complaint suppresses immediately. A bounce suppresses unless the provider
-- explicitly called it transient — a full mailbox comes back, a dead domain
-- does not, and treating an unlabelled bounce as permanent is the safer of the
-- two mistakes: the cost is one person who has to resubscribe, and the cost of
-- the other is a sending reputation.

CREATE OR REPLACE FUNCTION public.baaki_record_email_event(
  p_resend_email_id text,
  p_event           text,
  p_address         text DEFAULT NULL,
  p_payload         jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sent        record;
  v_address     text := lower(trim(COALESCE(p_address, '')));
  v_bounce_type text := p_payload #>> '{data,bounce,type}';
  v_suppressed  boolean := FALSE;
BEGIN
  IF p_event IS NULL OR p_event = '' THEN
    RAISE EXCEPTION 'baaki_record_email_event needs an event';
  END IF;

  SELECT e.notification_id, e.profile_id, e.template
    INTO v_sent
  FROM public.email_events e
  WHERE e.resend_email_id = p_resend_email_id
    AND e.event = 'sent'
  ORDER BY e.created_at
  LIMIT 1;

  IF v_sent.profile_id IS NOT NULL THEN
    INSERT INTO public.email_events
      (notification_id, profile_id, resend_email_id, template, event, payload)
    VALUES
      (v_sent.notification_id, v_sent.profile_id, p_resend_email_id,
       COALESCE(v_sent.template, 'unknown'), p_event, COALESCE(p_payload, '{}'::jsonb));

    -- The inbox row keeps up with what actually happened, so "we emailed you"
    -- in the UI is never a claim the evidence contradicts.
    IF p_event IN ('delivered', 'bounced', 'complained') AND v_sent.notification_id IS NOT NULL THEN
      UPDATE public.notifications
         SET email_status = p_event::public."DeliveryStatus"
       WHERE id = v_sent.notification_id;
    END IF;
  END IF;

  IF p_event = 'complained' THEN
    v_suppressed := public.baaki_suppress_email(v_address, 'complained', COALESCE(p_payload, '{}'::jsonb));
  ELSIF p_event = 'bounced' AND COALESCE(v_bounce_type, '') <> 'Transient' THEN
    v_suppressed := public.baaki_suppress_email(v_address, 'bounced', COALESCE(p_payload, '{}'::jsonb));
  END IF;

  RETURN jsonb_build_object(
    'matched', v_sent.profile_id IS NOT NULL,
    'suppressed', v_suppressed
  );
END
$$;

-- ──────────────────────────────────────────────────────── 6. who may ──

REVOKE ALL ON FUNCTION public.baaki_email_for(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_suppress_email(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_email_suppressed(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_claim_email_notifications(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_finish_email(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_record_email_event(text, text, text, jsonb) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    -- `baaki_email_for` is the sharpest of these: it turns a profile id, which
    -- every group member can see, into somebody's email address.
    REVOKE ALL ON FUNCTION public.baaki_email_for(uuid) FROM anon, authenticated;
    REVOKE ALL ON FUNCTION public.baaki_suppress_email(text, text, jsonb) FROM anon, authenticated;
    REVOKE ALL ON FUNCTION public.baaki_email_suppressed(text) FROM anon, authenticated;
    REVOKE ALL ON FUNCTION public.baaki_claim_email_notifications(integer) FROM anon, authenticated;
    REVOKE ALL ON FUNCTION public.baaki_finish_email(jsonb) FROM anon, authenticated;
    REVOKE ALL ON FUNCTION public.baaki_record_email_event(text, text, text, jsonb) FROM anon, authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.baaki_email_for(uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.baaki_suppress_email(text, text, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.baaki_email_suppressed(text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.baaki_claim_email_notifications(integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.baaki_finish_email(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.baaki_record_email_event(text, text, text, jsonb) TO service_role;
  END IF;
END
$$;

-- Every webhook call arrives knowing only Resend's id, so this is the lookup
-- the whole ingestion path hangs off. Not a partial index despite most rows
-- having one: Prisma cannot express a WHERE clause on an index, and the drift
-- check that gates merges would report it as an unexplained difference forever.
CREATE INDEX IF NOT EXISTS email_events_resend_email_id_idx
  ON public.email_events (resend_email_id);
