-- Nudge to settle — the sending half of the `nudge` notification (ADR-010,
-- TDR §7.1).
--
-- Everything the reminder needs to arrive already shipped in M4: the
-- `reminders` table, the one-per-pair-per-day rate-limit trigger, the `nudge`
-- copy in four languages, its inbox icon and its notification preference.
-- Nothing ever wrote the row. This is that writer, and nothing more.
--
-- Tone is the whole feature (ADR-010: friendly vasool, never a collections
-- agency). One debtor at a time, at most once a day, and only when they
-- genuinely owe you in the group you name. There is no bulk "remind everyone",
-- and there is no second reminder the same day — both are refused down here in
-- SQL, where no client bug can talk Baaki into becoming the thing it promised
-- not to be.

CREATE OR REPLACE FUNCTION public.baaki_nudge_to_settle(
  p_group_id     uuid,
  p_to_member_id uuid,
  p_currency     char(3)
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me            uuid;   -- my member in this group: the one who is owed
  v_my_name       text;
  v_their_profile uuid;
  v_group_name    text;
  v_amount        bigint;
  v_notification  uuid;
BEGIN
  -- The caller must be a present member of the group. Anyone else has no
  -- business reading who owes whom in it, let alone tapping them on the
  -- shoulder about it.
  SELECT gm.id, COALESCE(p.display_name, 'Someone')
    INTO v_me, v_my_name
    FROM public.group_members gm
    JOIN public.profiles p ON p.id = gm.profile_id
   WHERE gm.group_id = p_group_id
     AND gm.profile_id = public.baaki_current_profile_id()
     AND gm.left_at IS NULL;

  IF v_me IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_to_member_id = v_me THEN
    RAISE EXCEPTION 'CANNOT_NUDGE_SELF: that is you'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The person being nudged must be a present member with an account. A ghost
  -- has no inbox for it to land in — they are invited, not reminded (A25).
  SELECT gm.profile_id, g.name
    INTO v_their_profile, v_group_name
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id
   WHERE gm.id = p_to_member_id
     AND gm.group_id = p_group_id
     AND gm.left_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: they are not in that group'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_their_profile IS NULL THEN
    RAISE EXCEPTION 'GHOST_NO_INBOX: they have not joined yet — invite them instead'
      USING ERRCODE = 'check_violation';
  END IF;

  -- What they owe me in this currency, netting the two orientations the pair
  -- may be stored in (pairwise_balances holds each pair once, as `from` owing
  -- `to`). A nudge over a debt that is not there is the one thing that would
  -- make the reminder a lie, so a non-positive figure is refused rather than
  -- sent. Currency is explicit: two people can owe each other in two
  -- currencies at once, and there is no honest single number across them
  -- (ADR-003).
  SELECT COALESCE(
           (SELECT amount FROM public.pairwise_balances
             WHERE group_id = p_group_id AND from_member_id = p_to_member_id
               AND to_member_id = v_me AND currency = p_currency), 0)
       - COALESCE(
           (SELECT amount FROM public.pairwise_balances
             WHERE group_id = p_group_id AND from_member_id = v_me
               AND to_member_id = p_to_member_id AND currency = p_currency), 0)
    INTO v_amount;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'NOTHING_OWED: they do not owe you in %', p_currency
      USING ERRCODE = 'check_violation';
  END IF;

  -- Record the nudge. The unique index on (group, from, to) makes this an
  -- upsert; the BEFORE UPDATE trigger refuses a second touch inside a day with
  -- NUDGE_RATE_LIMIT. The INSERT path — the pair's first ever nudge — is not
  -- rate-limited, which is right: there is nothing for it to be too soon after.
  INSERT INTO public.reminders (group_id, from_member_id, to_member_id, last_nudged_at)
  VALUES (p_group_id, v_me, p_to_member_id, now())
  ON CONFLICT (group_id, from_member_id, to_member_id)
  DO UPDATE SET last_nudged_at = now();

  -- Land it in their inbox. The English title/body are the fallback a client
  -- shows only for a kind it does not know; every current build renders the
  -- real sentence from `kind` + `payload` in the reader's own language, so the
  -- `counterparty`/`amount`/`currency`/`group` facts are what actually matter.
  -- The dedupe key is per pair per day — a belt to the rate limit's braces, so
  -- even a retried call is a no-op rather than a second buzz.
  v_notification := public.baaki_notify(
    v_their_profile,
    p_group_id,
    'nudge',
    'A gentle nudge from ' || v_my_name,
    'You have a pending baaki in ' || v_group_name,
    'baaki://group/' || p_group_id::text,
    jsonb_build_object(
      'counterparty', v_my_name,
      'amount',       v_amount::text,
      'currency',     p_currency,
      'group',        v_group_name
    ),
    'nudge:' || p_group_id::text || ':' || v_me::text || ':' || p_to_member_id::text
      || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
  );

  RETURN v_notification;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_nudge_to_settle(uuid, uuid, char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_nudge_to_settle(uuid, uuid, char) TO authenticated;

-- A new function the API serves; tell PostgREST so the RPC is callable the
-- moment this lands, not on its next restart.
NOTIFY pgrst, 'reload schema';
