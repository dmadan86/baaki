-- notify-fanout had no retry and `group_added` had no fallback.
--
-- Two gaps found together, fixed together, because they compound: a push has
-- always been terminal on the first bad ticket — `baaki_claim_push_notifications`
-- only ever looks at `push_status IS NULL`, so one `DeviceNotRegistered` or one
-- transient Expo hiccup ended the story for that row, no matter which. TDR
-- §7.1 says transient errors get retried with backoff (max 3); the code never
-- did that. And `group_added` has always been push-only — it was never on
-- `baaki_claim_email_notifications`'s whitelist, and since the in-app Inbox
-- screen was removed (#565) there is no other door left. Put those together
-- and a person who was added to a group, whose push token had gone stale, had
-- no way at all to find out — not a retry, not a mail, not a screen.
--
-- `push_attempts` / `push_next_retry_at` give push three tries with backoff
-- (3 then 9 minutes) before a row is truly done. `group_added` joins the email
-- whitelist as a fallback, gated exactly like `nudge` already is (TDR §7.4):
-- mailed only when there is no live device to push to, or push has exhausted
-- its retries — never as a second copy alongside a push that is still trying.

ALTER TABLE public.notifications
  ADD COLUMN push_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN push_next_retry_at timestamptz;

--
-- Name: baaki_claim_push_notifications(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.baaki_claim_push_notifications(p_limit integer DEFAULT 200) RETURNS TABLE(id uuid, kind text, title text, body text, deep_link text, payload jsonb, locale text, tokens text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ids UUID[];
BEGIN
  -- The claim, in one statement. `FOR UPDATE SKIP LOCKED` is what lets two
  -- runs overlap harmlessly: the second finds the rows locked and moves on
  -- rather than sending them again.
  --
  -- A first try (`push_status IS NULL`) and a retry (`failed`, under 3
  -- attempts, and its backoff has elapsed) are the same claim — the only
  -- difference is which WHERE clause let the row through.
  WITH picked AS (
    SELECT n.id
    FROM public.notifications n
    WHERE (
            n.push_status IS NULL
         OR (n.push_status = 'failed'
             AND n.push_attempts < 3
             AND n.push_next_retry_at IS NOT NULL
             AND n.push_next_retry_at <= now())
          )
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
  -- `push_attempts` is left untouched — a new token showing up later is a
  -- different signal than time passing, not the backoff's business — but
  -- `push_next_retry_at` MUST be cleared: a row already mid-retry (attempt 1
  -- failed with `DeviceNotRegistered`, which revokes the token in the same
  -- call) would otherwise keep a past-due retry time forever, since it is
  -- `failed` with no unrevoked token and so never reaches `RETURN QUERY` to
  -- have `baaki_finish_push` push its attempt count past 3. Left set, that
  -- timestamp makes the claim above match it again on every single run until
  -- the two-day cutoff, ahead of fresh notifications (`ORDER BY created_at`).
  -- Clearing it here is what makes "no device" terminal the moment it is
  -- discovered, on a first attempt or a retry alike.
  UPDATE public.notifications n
     SET push_status = 'failed',
         push_next_retry_at = NULL
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

--
-- Name: baaki_finish_push(uuid[], uuid[], text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.baaki_finish_push(p_delivered uuid[] DEFAULT '{}'::uuid[], p_failed uuid[] DEFAULT '{}'::uuid[], p_revoke text[] DEFAULT '{}'::text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- 'sent' rather than 'delivered': Expo accepting a message is as much as this
  -- layer can know. The phone may be off. Recording more than actually happened
  -- is a lie the UI would go on to repeat.
  --
  -- `push_next_retry_at` is cleared here too, not just left inert. A row that
  -- succeeded on attempt 2 has no attempt 3 coming, but until this clears it,
  -- the timestamp from attempt 1's failure is still sitting there — nothing
  -- reads it once `push_status = 'sent'`, but `group_added`'s email
  -- suppression below reads `push_status`, and a terminal row should not
  -- still be carrying scheduling metadata for a retry that will never run.
  UPDATE public.notifications
     SET push_status = 'sent',
         push_next_retry_at = NULL
   WHERE id = ANY(p_delivered);

  -- A failure counts itself and, under 3 attempts, schedules the next one —
  -- 3 minutes after the first, 9 after the second. The third failure leaves
  -- `push_next_retry_at` null, which is what tells the claim above to stop
  -- asking: `push_attempts < 3` alone would still be true at attempt 3, and
  -- without this the row would sit `failed` forever looking retryable but
  -- never picked up, since nothing set a due time for a fourth try that was
  -- never meant to happen.
  UPDATE public.notifications
     SET push_status = 'failed',
         push_attempts = push_attempts + 1,
         push_next_retry_at = CASE
           WHEN push_attempts + 1 < 3
             THEN now() + (power(3, push_attempts + 1) * interval '1 minute')
           ELSE NULL
         END
   WHERE id = ANY(p_failed);

  -- Soft, not deleted: the row is evidence of a device that existed, and the
  -- same token coming back later is a reinstall rather than a new device.
  UPDATE public.push_tokens
     SET revoked_at = now()
   WHERE expo_push_token = ANY(p_revoke) AND revoked_at IS NULL;
END
$$;

--
-- Name: baaki_claim_email_notifications(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.baaki_claim_email_notifications(p_limit integer DEFAULT 100) RETURNS TABLE(id uuid, kind text, title text, body text, deep_link text, payload jsonb, locale text, address text, group_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
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
      -- `group_added` joins the list here as a fallback, not routine mail —
      -- see the suppression clause below, which is what keeps it rare.
      AND n.kind IN ('settlement_initiated', 'settlement_confirm_request', 'digest_daily', 'nudge', 'group_added')
      -- `group_added`'s fallback depends on how push turns out, and push can
      -- now take several fanout runs to find that out (the retry backoff
      -- above). Every other kind on this list is decided the moment it is
      -- claimed — a nudge only ever asks "is there a device", never "did the
      -- push succeed" — so only `group_added` needs to wait. Without this,
      -- the very first run would claim and terminally suppress a
      -- `group_added` row for anyone with a live device (the suppression
      -- clause below reads as "has a device, and push hasn't yet failed
      -- three times" — true on attempt zero), before push had tried even
      -- once, let alone exhausted its three tries. `email_status IS NULL`
      -- above never lets a row be claimed a second time, so a row claimed
      -- that early is claimed once, wrongly, forever.
      AND (
        n.kind <> 'group_added'
        OR n.push_status = 'sent'
        OR (n.push_status = 'failed' AND n.push_next_retry_at IS NULL)
      )
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

  -- The same rule for `group_added`, plus two more ways in. A push that
  -- already succeeded suppresses unconditionally — a device existing right
  -- now (or not) at the moment this claim happens says nothing about whether
  -- push already landed; `push_status = 'sent'` is the one fact that can never
  -- change again, so it is checked directly rather than through the token
  -- table. A live device that push has already given up on (3 failed
  -- attempts, no retry left) is the actual fallback case — a device existing
  -- is not the same as a push reaching it, and this is the one kind with
  -- nowhere else to land if that push never does.
  --
  -- Reading `EXISTS (active token)` alone here — as the first version of this
  -- migration did — suppressed on device presence rather than push outcome,
  -- which meant a push that succeeded and then had its token revoked before
  -- this ran (sign-out, reinstall) fell through the `push_status = 'sent'`
  -- case entirely and got mailed anyway: a duplicate, after the push had
  -- already worked.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND n.email_status = 'queued'
     AND n.kind = 'group_added'
     AND (
       n.push_status = 'sent'
       OR (
         EXISTS (
           SELECT 1 FROM public.push_tokens t
           WHERE t.profile_id = n.profile_id AND t.revoked_at IS NULL
         )
         AND NOT (n.push_status = 'failed' AND n.push_attempts >= 3)
       )
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

-- All three are SECURITY DEFINER (they read every profile's notifications and
-- push tokens across the whole table) and are re-created above, which mints a
-- fresh grant set. `REVOKE ... FROM PUBLIC` alone does not stop `anon` —
-- Supabase's default privileges grant EXECUTE directly to `anon` (and
-- `authenticated`) as each function is created, bypassing PUBLIC entirely
-- (the trap [[baaki-anon-surface-hardening]] found live on five other
-- functions). House pattern: revoke from PUBLIC, anon AND authenticated —
-- only the fanout's own service-role caller may run any of these.
REVOKE ALL ON FUNCTION public.baaki_claim_push_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_claim_push_notifications(integer) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_finish_push(uuid[], uuid[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_finish_push(uuid[], uuid[], text[]) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_claim_email_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_claim_email_notifications(integer) TO service_role;
