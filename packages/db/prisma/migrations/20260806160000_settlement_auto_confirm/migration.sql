-- Settlement auto-confirm, and the inbox that tells both people (TDR §5, ADR-007).
--
-- The settlement state machine has always had a hole at the end of it. A payer
-- opens their UPI app, pays, comes back and says so; the settlement sits at
-- `initiated` waiting for the payee to confirm. If the payee never opens the
-- app again — which is the common case, because from their side nothing is
-- owed any more — the money stays owed forever in Baaki and the group's
-- balances are quietly wrong.
--
-- ADR-007 answers that with time: after seven days with no response, the
-- settlement is taken as confirmed and both people are told. Confirmation here
-- is social rather than cryptographic, so the safety valve is that a dispute
-- still reopens an auto-confirmed settlement — the status trigger already
-- permits `auto_confirmed → disputed` and nothing here changes that.
--
-- Two things are deliberately *not* done:
--   * Nothing is auto-confirmed on the payee's behalf while they are still
--     being asked. The nudge is a notification, not a state change.
--   * The job never touches `confirmed`, `disputed` or `cancelled` rows. It
--     only ever resolves the one state that has been left hanging.

-- ─────────────────────────────────────────── 1. an inbox that cannot double-send ──
-- TDR §7.1 wants no double-send when a fanout is retried. A retry is not an
-- error condition here — a scheduled job that runs twice, an edge function that
-- times out after writing — so the guarantee belongs in the table rather than
-- in whoever is careful enough to check first.

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- Not partial: Postgres already lets a unique index hold any number of NULLs,
-- so the rows that opt out of deduplication need no special case.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_dedupe_key_key"
  ON public.notifications (dedupe_key);

COMMENT ON COLUMN public.notifications.dedupe_key IS
  'Idempotency for fanout: one row per (recipient, event). Retrying a send is a no-op.';

-- ────────────────────────────────────────────────── 2. writing to the inbox ──
-- `title` and `body` are stored in English and are a fallback, not the product.
-- The client renders the real thing from `kind` + `payload` through the copy
-- table in @baaki/core, which is the only place that knows the reader's
-- language (TDR §11: en + ta + hi from day one). Postgres has no business
-- holding three translations of every sentence.

CREATE OR REPLACE FUNCTION public.baaki_notify(
  p_profile_id uuid,
  p_group_id   uuid,
  p_kind       text,
  p_title      text,
  p_body       text,
  p_deep_link  text,
  p_payload    jsonb,
  p_dedupe_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- A ghost member has no profile to notify. Silently skipping is right: they
  -- are a placeholder for somebody who has not joined yet.
  IF p_profile_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notifications
    (profile_id, group_id, kind, title, body, deep_link, payload, channels, dedupe_key)
  VALUES
    (p_profile_id, p_group_id, p_kind, p_title, p_body, p_deep_link,
     COALESCE(p_payload, '{}'::jsonb), ARRAY['in_app']::text[], p_dedupe_key)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

-- ──────────────────────────────────────────────── 3. the seven-day resolution ──
-- Takes the cutoff as an argument rather than hard-coding `now()`. A job whose
-- clock cannot be moved can only be tested by waiting a week, which means it
-- would not be tested.

CREATE OR REPLACE FUNCTION public.baaki_auto_confirm_settlements(
  p_now    timestamptz DEFAULT now(),
  p_window interval    DEFAULT interval '7 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     record;
  v_count   integer := 0;
  v_amount  text;
BEGIN
  FOR v_row IN
    SELECT s.id,
           s.group_id,
           s.amount,
           s.currency,
           s.from_member_id,
           s.to_member_id,
           g.name                AS group_name,
           payer.profile_id      AS payer_profile,
           -- A member is either a real profile or a ghost standing in for
           -- somebody who has not joined; the name lives in whichever it is.
           COALESCE(payer_profile.display_name, payer.ghost_name) AS payer_name,
           payee.profile_id      AS payee_profile,
           COALESCE(payee_profile.display_name, payee.ghost_name) AS payee_name
    FROM public.settlements s
    JOIN public.groups g            ON g.id = s.group_id
    JOIN public.group_members payer ON payer.id = s.from_member_id
    JOIN public.group_members payee ON payee.id = s.to_member_id
    LEFT JOIN public.profiles payer_profile ON payer_profile.id = payer.profile_id
    LEFT JOIN public.profiles payee_profile ON payee_profile.id = payee.profile_id
    WHERE s.status = 'initiated'
      AND s.initiated_at <= p_now - p_window
    -- Locked so two overlapping runs of the job cannot both claim the same
    -- settlement; the second simply finds nothing to do.
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.settlements
       SET status = 'auto_confirmed'
     WHERE id = v_row.id;

    INSERT INTO public.activity_log
      (group_id, actor_member_id, verb, object_type, object_id, payload)
    VALUES
      (v_row.group_id, NULL, 'auto_confirmed', 'settlement', v_row.id,
       jsonb_build_object('amount', v_row.amount::text, 'currency', v_row.currency,
                          'reason', 'no_response_in_window'));

    v_amount := v_row.amount::text;

    -- Both people are told, and the wording differs because their positions
    -- do. The payee is the one who might want to dispute it.
    PERFORM public.baaki_notify(
      v_row.payee_profile, v_row.group_id, 'settlement_confirmed',
      'Settled automatically',
      COALESCE(v_row.payer_name, 'Someone') || ' paid you, and nobody said otherwise for a week',
      'baaki://group/' || v_row.group_id::text,
      jsonb_build_object('settlementId', v_row.id, 'amount', v_amount,
                         'currency', v_row.currency, 'role', 'payee',
                         'counterparty', v_row.payer_name, 'group', v_row.group_name),
      'auto_confirm:' || v_row.id::text || ':payee'
    );

    PERFORM public.baaki_notify(
      v_row.payer_profile, v_row.group_id, 'settlement_confirmed',
      'Settled automatically',
      'Your payment to ' || COALESCE(v_row.payee_name, 'them') || ' was confirmed after a week',
      'baaki://group/' || v_row.group_id::text,
      jsonb_build_object('settlementId', v_row.id, 'amount', v_amount,
                         'currency', v_row.currency, 'role', 'payer',
                         'counterparty', v_row.payee_name, 'group', v_row.group_name),
      'auto_confirm:' || v_row.id::text || ':payer'
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

-- ──────────────────────────────────────────────────────── 4. reading the inbox ──

CREATE OR REPLACE FUNCTION public.baaki_mark_notifications_read(p_ids uuid[])
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  -- SECURITY INVOKER on purpose: `notifications_update_own` is what decides
  -- whose inbox this is, and it is the same policy a direct PATCH would meet.
  WITH marked AS (
    UPDATE public.notifications
       SET read_at = now()
     WHERE id = ANY(p_ids) AND read_at IS NULL
    RETURNING 1
  )
  SELECT COUNT(*)::integer FROM marked;
$$;

-- The job runs as the service role or from cron. Handing it to `authenticated`
-- would let any signed-in person confirm every pending settlement in the
-- database on demand.
REVOKE ALL ON FUNCTION public.baaki_auto_confirm_settlements(timestamptz, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_notify(uuid, uuid, text, text, text, text, jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  public.baaki_mark_notifications_read(uuid[])
TO authenticated, anon;

-- ───────────────────────────────────────────────────── 5. live inbox + schedule ──

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename = 'notifications'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END
$$;

-- pg_cron exists on Supabase and not in a bare Postgres container, so this is
-- guarded rather than assumed. Hourly, not daily: the seven-day promise should
-- not turn into "some time on the eighth day".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule('baaki-auto-confirm')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'baaki-auto-confirm');
    PERFORM cron.schedule(
      'baaki-auto-confirm', '7 * * * *',
      'SELECT public.baaki_auto_confirm_settlements()'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- A database without permission to create extensions must still migrate.
  RAISE NOTICE 'pg_cron not scheduled: %', SQLERRM;
END
$$;
