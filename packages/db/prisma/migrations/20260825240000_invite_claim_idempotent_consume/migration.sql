-- A pending ghost-claim must not burn an invite use it can never give back.
--
-- The hole (invite-accept): `baaki_consume_invite` ran BEFORE the claim branch,
-- so the moment someone tapped "I'm Ravi" a `max_uses` slot was spent — whether
-- or not an admin ever agreed, and, worse, EVERY time they tapped. A pending
-- claimant is not a member, so `baaki_request_member_claim` happily returned
-- `already_pending` on the second, third, hundredth attempt while the caller had
-- already re-run the consume each time. A valid link capped at N uses could be
-- emptied by one person re-POSTing the same claim N times, or by N bogus claims
-- on N ghosts, with nobody ever joining. The organizer's link looks "full"; no
-- one is in the group.
--
-- The fix (semantic #2 from the brief — "consume at most once per
-- (invite, profile, member), idempotently"): consumption moves OUT of the edge
-- function's claim path and INTO this function, placed so it fires exactly once,
-- for exactly one genuinely-new pending claim, and never for a repeat or a
-- doomed request:
--
--   * NOT_CLAIMABLE / ALREADY_CLAIMED / ALREADY_A_MEMBER  -> no use spent.
--   * already-pending (the same person asking again)      -> no use spent;
--     the existing claim is the answer, so the link is not touched. This is the
--     idempotency that closes the repeat-exhaustion abuse.
--   * a brand-new, valid claim                            -> one use spent,
--     atomically, in the same transaction as the INSERT. If the link is spent or
--     invalid by then, the claim is refused and nothing is written.
--
-- Because the whole function is one transaction and the member row is held
-- `FOR UPDATE`, two concurrent requests for the same place cannot both file a new
-- claim — the loser sees the winner's pending row and returns already_pending
-- without consuming. And `baaki_consume_invite` itself is a single atomic
-- conditional UPDATE, so two DIFFERENT new claims racing for a link's LAST slot
-- (or a claim racing a direct join) serialise on the invite row: exactly one wins.
--
-- A direct (non-claim) join is unchanged: invite-accept still calls
-- `baaki_consume_invite` once, right before it inserts the membership, so a normal
-- join still spends exactly one use.
--
-- Why not "consume only on approval"? That would need to carry the invite id to
-- `baaki_decide_member_claim`, i.e. a new column on `member_claims` (a Prisma
-- model) and the drift that comes with it. Reserving idempotently at request
-- time closes the reported abuse (repeat / bogus exhaustion) with a functions-only
-- change and no schema drift.

-- Signature changes (a 5th argument), so the old overload must go first —
-- CREATE OR REPLACE would otherwise leave a second, ambiguous function behind.
DROP FUNCTION IF EXISTS public.baaki_request_member_claim(uuid, uuid, uuid, text);

/**
 * Record a request to take a ghost's place, reserving one invite use for a
 * genuinely-new claim and nothing for a repeat or a doomed one.
 *
 * Service-role only, and takes the profile explicitly: the caller is
 * `invite-accept`, which has already verified a signed invite token. The person
 * asking is not a member of the group yet and has no other standing to be here,
 * so there is nothing for a client-side check to check.
 *
 * `p_invite_id` is the link they came through. When given, one use is consumed
 * for a new claim (and only then); when NULL — e.g. an internal caller with no
 * link in hand — no use is touched. Returns a verdict rather than raising,
 * because every refusal is a sentence to show somebody who just tapped their own
 * name.
 */
CREATE OR REPLACE FUNCTION public.baaki_request_member_claim(
  p_group_id   uuid,
  p_member_id  uuid,
  p_profile_id uuid,
  p_name       text DEFAULT NULL,
  p_invite_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member   public.group_members%ROWTYPE;
  v_group    text;
  v_id       uuid;
  v_admin    record;
  v_consumed boolean;
BEGIN
  SELECT * INTO v_member
    FROM public.group_members
   WHERE id = p_member_id AND group_id = p_group_id
   FOR UPDATE;

  IF NOT FOUND OR v_member.left_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NOT_CLAIMABLE');
  END IF;

  -- Already somebody's. The check is repeated at decision time as well: this
  -- one is for the sentence, that one is for the guarantee.
  IF v_member.profile_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_CLAIMED');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.group_members
     WHERE group_id = p_group_id AND profile_id = p_profile_id AND left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_A_MEMBER');
  END IF;

  -- The same person asking twice. Their existing request is the answer, and a
  -- second notification to every admin is not — and, since this migration, a
  -- second invite use is not either. Safe under the `FOR UPDATE` on the member
  -- above, which serialises requests for one place, so two concurrent asks
  -- cannot both slip past this into the consume below.
  SELECT id INTO v_id
    FROM public.member_claims
   WHERE member_id = p_member_id AND requester_id = p_profile_id AND status = 'pending';

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'claim_id', v_id, 'already_pending', true);
  END IF;

  -- Past every short-circuit: this is a brand-new claim, and only now is a use
  -- worth spending. The consume is atomic (a conditional UPDATE that re-checks
  -- revocation, expiry and the cap under the invite's row lock), so if the link
  -- has filled up — including a direct join or another new claim winning the
  -- last slot in a concurrent race — this claim is refused and no row is written.
  IF p_invite_id IS NOT NULL THEN
    SELECT public.baaki_consume_invite(p_invite_id) INTO v_consumed;
    IF v_consumed IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'INVITE_INVALID');
    END IF;
  END IF;

  INSERT INTO public.member_claims (group_id, member_id, requester_id, requested_name)
  VALUES (p_group_id, p_member_id, p_profile_id, NULLIF(btrim(COALESCE(p_name, '')), ''))
  RETURNING id INTO v_id;

  SELECT name INTO v_group FROM public.groups WHERE id = p_group_id;

  -- Every admin, not just the creator. A group whose only admin has stopped
  -- opening the app is a group where nobody can ever join again.
  FOR v_admin IN
    SELECT profile_id FROM public.group_members
     WHERE group_id = p_group_id AND role = 'admin'
       AND profile_id IS NOT NULL AND left_at IS NULL
  LOOP
    PERFORM public.baaki_notify(
      v_admin.profile_id,
      p_group_id,
      'ghost_claim_requested',
      'Someone wants to join ' || COALESCE(v_group, 'a group'),
      'They say they are ' || COALESCE(v_member.ghost_name, 'someone already listed'),
      '/group/' || p_group_id::text || '/members',
      jsonb_build_object(
        'claim_id', v_id,
        'member_id', p_member_id,
        'ghost_name', v_member.ghost_name,
        'requested_name', NULLIF(btrim(COALESCE(p_name, '')), '')
      ),
      'claim:' || v_id::text || ':' || v_admin.profile_id::text
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'claim_id', v_id, 'already_pending', false);
END
$$;

REVOKE ALL ON FUNCTION public.baaki_request_member_claim(uuid, uuid, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_request_member_claim(uuid, uuid, uuid, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_request_member_claim(uuid, uuid, uuid, text, uuid) TO service_role;
