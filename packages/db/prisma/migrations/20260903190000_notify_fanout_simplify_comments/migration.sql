-- Trims the notify-fanout functions down to the comments they should have
-- shipped with — the three touched by 20260903160000 ended up carrying a
-- round-by-round changelog of what a review pass caught, which is exactly
-- the kind of comment that reads well for a week and rots afterward (the
-- PR history is where that belongs). No behaviour changes here: same claim
-- predicates, same backoff, same suppression rules, verified against the
-- same test suite.

CREATE OR REPLACE FUNCTION public.baaki_claim_push_notifications(p_limit integer DEFAULT 200) RETURNS TABLE(id uuid, kind text, title text, body text, deep_link text, payload jsonb, locale text, tokens text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ids UUID[];
BEGIN
  -- `FOR UPDATE SKIP LOCKED` is what lets two runs overlap harmlessly: the
  -- second finds the rows locked and moves on rather than sending them
  -- again. A first try (`push_status IS NULL`) and a retry (`failed`, under
  -- 3 attempts, backoff elapsed) are the same claim, differing only in which
  -- half of the WHERE let the row through.
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

  -- A separate statement: Postgres will not apply two updates to the same
  -- row inside one statement, so folding this into the CTE above would
  -- silently do nothing.
  --
  -- No device is a decision, not a failure — closed out terminally
  -- (`push_next_retry_at` cleared, not just `push_status`) rather than left
  -- retryable, or it would sit in the claim's way on every future run.
  -- `push_attempts` is left alone: a new token showing up later is a
  -- different signal than time passing, and not this branch's business.
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

CREATE OR REPLACE FUNCTION public.baaki_finish_push(p_delivered uuid[] DEFAULT '{}'::uuid[], p_failed uuid[] DEFAULT '{}'::uuid[], p_revoke text[] DEFAULT '{}'::text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- 'sent' rather than 'delivered': Expo accepting a message is as much as
  -- this layer can know. `push_next_retry_at` is cleared alongside it — a
  -- terminal row should not still carry scheduling metadata for a retry
  -- that will never run.
  UPDATE public.notifications
     SET push_status = 'sent',
         push_next_retry_at = NULL
   WHERE id = ANY(p_delivered);

  -- A failure counts itself and, under 3 attempts, schedules the next one —
  -- 3 minutes after the first, 9 after the second. The third leaves
  -- `push_next_retry_at` null: `push_attempts < 3` alone would still be true
  -- at attempt 3, so the claim above needs this to know there is no fourth
  -- try coming.
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
      -- Same two days as push — a mail about a reminder from Tuesday is
      -- worse than no mail.
      AND n.created_at > now() - interval '2 days'
      -- `group_added` is a fallback for when push never lands (no in-app
      -- inbox to check instead, #565), not routine mail — the suppression
      -- clause below is what keeps it rare.
      AND n.kind IN ('settlement_initiated', 'settlement_confirm_request', 'digest_daily', 'nudge', 'group_added')
      -- Every other kind on this list is decided the moment it is claimed —
      -- a nudge only ever asks "is there a device", never "did the push
      -- succeed". `group_added` asks the second question, and push can take
      -- several fanout runs to answer it (the retry backoff above). Since
      -- `email_status IS NULL` never lets a row be claimed twice, claiming
      -- it before push is done would decide — wrongly, permanently — before
      -- push had even tried once.
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

  -- Separate statements — Postgres will not apply two updates to the same
  -- row inside one statement.

  -- No address, no confirmed address, or email turned off. Not a failure; a
  -- decision, marked as one so it never gets retried.
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

  -- TDR §7.4: a nudge goes by email only to somebody with no live device —
  -- everybody else already got a buzz about it.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND n.email_status = 'queued'
     AND n.kind = 'nudge'
     AND EXISTS (
       SELECT 1 FROM public.push_tokens t
       WHERE t.profile_id = n.profile_id AND t.revoked_at IS NULL
     );

  -- `group_added` suppresses on two different facts, checked in the order
  -- that matters: a push that already succeeded is suppressed outright
  -- (`push_status = 'sent'` cannot change again, unlike whether a device
  -- happens to be live at the moment this runs — checking the token table
  -- first would wrongly re-open a push that already landed). Short of that,
  -- it suppresses exactly like a nudge: a live device and fewer than 3
  -- failed attempts means push might still land, so no mail yet.
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

-- Re-creating mints a fresh grant set, so the caller model has to be
-- re-declared every time: `REVOKE ... FROM PUBLIC` alone does not stop
-- `anon` (Supabase grants it directly — [[baaki-anon-surface-hardening]]).
-- Service-role only; nobody signed in reads across every profile's
-- notifications and push tokens.
REVOKE ALL ON FUNCTION public.baaki_claim_push_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_claim_push_notifications(integer) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_finish_push(uuid[], uuid[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_finish_push(uuid[], uuid[], text[]) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_claim_email_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_claim_email_notifications(integer) TO service_role;
