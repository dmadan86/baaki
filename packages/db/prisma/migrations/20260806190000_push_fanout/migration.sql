-- Getting a notification onto a phone (TDR §7.1).
--
-- The inbox already holds everything Baaki has said. This is the part that
-- taps somebody on the shoulder about it, and the two halves that must not be
-- got wrong both live here rather than in the edge function:
--
--   * **Claiming.** A fanout that reads rows and then sends them will send
--     twice the moment two runs overlap or one times out after sending. The
--     claim is an UPDATE, so a row belongs to exactly one run the instant it is
--     picked up, and a second run finds nothing.
--   * **Finishing.** What came back has to land against the right rows, and a
--     device that is genuinely gone has to be dropped — otherwise every future
--     fanout pays to fail at it forever.
--
-- Neither function is reachable by a signed-in user. The fanout runs as the
-- service role, which is the only identity that has any business reading
-- somebody else's inbox.

-- ─────────────────────────────────────────────────────────── 1. claiming ──

CREATE OR REPLACE FUNCTION public.baaki_claim_push_notifications(p_limit INTEGER DEFAULT 200)
RETURNS TABLE (
  id        UUID,
  kind      TEXT,
  title     TEXT,
  body      TEXT,
  deep_link TEXT,
  payload   JSONB,
  locale    TEXT,
  tokens    TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  -- The claim, in one statement. `FOR UPDATE SKIP LOCKED` is what lets two
  -- runs overlap harmlessly: the second finds the rows locked and moves on
  -- rather than sending them again.
  WITH picked AS (
    SELECT n.id
    FROM public.notifications n
    WHERE n.push_status IS NULL
      -- Anything older than this was missed while the fanout was down, and a
      -- buzz about a two-day-old reminder is worse than silence.
      AND n.created_at > now() - interval '2 days'
    ORDER BY n.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.notifications n
       SET push_status = 'queued'
      FROM picked
     WHERE n.id = picked.id
    RETURNING n.id
  )
  SELECT COALESCE(array_agg(claimed.id), '{}') INTO v_ids FROM claimed;

  -- A separate statement on purpose: Postgres will not apply two updates to the
  -- same row inside one statement, so closing these out in a CTE beside the
  -- claim above would silently do nothing.
  --
  -- Somebody with no device is not a failure to retry. Plenty of people only
  -- ever read the inbox, and leaving their rows unsent grows the queue forever.
  UPDATE public.notifications n
     SET push_status = 'failed'
   WHERE n.id = ANY(v_ids)
     AND NOT EXISTS (
       SELECT 1 FROM public.push_tokens t
       WHERE t.profile_id = n.profile_id AND t.revoked_at IS NULL
     );

  RETURN QUERY
  SELECT n.id, n.kind, n.title, n.body, n.deep_link, n.payload,
         COALESCE(p.locale, 'en'),
         ARRAY_AGG(t.expo_push_token)
  FROM public.notifications n
  LEFT JOIN public.profiles p ON p.id = n.profile_id
  JOIN public.push_tokens t
    ON t.profile_id = n.profile_id AND t.revoked_at IS NULL
  WHERE n.id = ANY(v_ids) AND n.push_status = 'queued'
  GROUP BY n.id, n.kind, n.title, n.body, n.deep_link, n.payload, p.locale;
END
$$;

-- ────────────────────────────────────────────────────────── 2. finishing ──

CREATE OR REPLACE FUNCTION public.baaki_finish_push(
  p_delivered UUID[] DEFAULT '{}',
  p_failed    UUID[] DEFAULT '{}',
  p_revoke    TEXT[] DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 'sent' rather than 'delivered': Expo accepting a message is as much as this
  -- layer can know. The phone may be off. Recording more than actually happened
  -- is a lie the UI would go on to repeat.
  UPDATE public.notifications
     SET push_status = 'sent'
   WHERE id = ANY(p_delivered);

  UPDATE public.notifications
     SET push_status = 'failed'
   WHERE id = ANY(p_failed);

  -- Soft, not deleted: the row is evidence of a device that existed, and the
  -- same token coming back later is a reinstall rather than a new device.
  UPDATE public.push_tokens
     SET revoked_at = now()
   WHERE expo_push_token = ANY(p_revoke) AND revoked_at IS NULL;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_claim_push_notifications(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_finish_push(uuid[], uuid[], text[]) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.baaki_claim_push_notifications(integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.baaki_finish_push(uuid[], uuid[], text[]) TO service_role;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────── 3. schedule ──
-- The fanout is an edge function, so Postgres has to make an HTTP call to run
-- it: pg_cron for the when, pg_net for the how.
--
-- The service key is read from Supabase Vault rather than written here. A
-- migration is a file in a public repository, and the key it would contain
-- reads every row in the database. If the secret is absent the schedule is
-- simply not created — a fanout that never runs leaves every notification in
-- the inbox, which is where it already was.
--
-- To turn it on:
--   select vault.create_secret('<service-role-key>', 'baaki_fanout_key');
--   select vault.create_secret('https://<ref>.supabase.co', 'baaki_functions_url');
-- then re-run this block, or schedule it by hand from the dashboard.

DO $$
DECLARE
  v_key  TEXT;
  v_url  TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net')
  THEN
    RAISE NOTICE 'push fanout not scheduled: pg_cron/pg_net unavailable';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS pg_cron;
  CREATE EXTENSION IF NOT EXISTS pg_net;

  BEGIN
    SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'baaki_fanout_key';
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'baaki_functions_url';
  EXCEPTION WHEN OTHERS THEN
    v_key := NULL;
  END;

  IF v_key IS NULL OR v_url IS NULL THEN
    RAISE NOTICE 'push fanout not scheduled: no vault secret. See the comment above this block.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('baaki-notify-fanout')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'baaki-notify-fanout');

  -- Every five minutes. A reminder that arrives four minutes late is still a
  -- reminder; a fanout that runs every minute is mostly a bill.
  PERFORM cron.schedule(
    'baaki-notify-fanout', '*/5 * * * *',
    format(
      $job$SELECT net.http_post(
             url := %L,
             headers := jsonb_build_object('Content-Type', 'application/json',
                                           'Authorization', %L)
           )$job$,
      v_url || '/functions/v1/notify-fanout',
      'Bearer ' || v_key
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'push fanout not scheduled: %', SQLERRM;
END
$$;
