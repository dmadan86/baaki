-- Taking over somebody's place in a group now needs somebody to say yes.
--
-- ADR-006: "When a real person joins via link, they can claim a ghost
-- (organizer confirms) and inherit its history atomically." The claim was
-- built; the confirmation was not. `invite-accept` handed the ghost over the
-- moment it was asked, which means anybody holding the link could become
-- "Ravi" and inherit every share, payment and settlement filed against that
-- name. An invite link is signed, expiring and revocable — and it also sits in
-- a group chat that everyone can read, so "whoever has the link" is not a
-- small set of people.
--
-- A claim is now a request. It changes nothing until an admin of the group
-- decides, and the person waiting is told which it was.
--
-- The decision is a SECURITY DEFINER function rather than an edge function so
-- that "who may approve this" is one line of SQL next to the table it guards,
-- instead of a check in a Deno file that can be forgotten on the next path in.

-- ────────────────────────────────────────────────────────── the request ──

CREATE TABLE IF NOT EXISTS public.member_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON UPDATE CASCADE on every relation to match what Prisma generates, which
  -- is what `db:drift` compares against.
  group_id      uuid NOT NULL REFERENCES public.groups(id)        ON DELETE CASCADE ON UPDATE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.group_members(id) ON DELETE CASCADE ON UPDATE CASCADE,
  requester_id  uuid NOT NULL REFERENCES public.profiles(id)      ON DELETE CASCADE ON UPDATE CASCADE,
  -- What the arrival calls themselves. Shown to whoever decides, because
  -- "somebody wants to be Ravi" is not a question anyone can answer.
  requested_name text,
  status        text NOT NULL DEFAULT 'pending',
  -- The membership that decided, not the profile: an admin who later leaves
  -- still decided it, and the row should still say so.
  decided_by    uuid REFERENCES public.group_members(id) ON DELETE SET NULL ON UPDATE CASCADE,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT member_claims_status_known
    CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  -- Decided exactly when it is not pending. Without this a row can claim to be
  -- approved with nothing recording when, which is the state that makes an
  -- audit useless.
  CONSTRAINT member_claims_decided_shape
    CHECK ((status = 'pending') = (decided_at IS NULL))
);

-- Deliberately no partial unique index on (member_id, requester_id) WHERE
-- pending, which is what "one open request per person per place" would want.
-- Prisma's datamodel cannot express a partial index, so the one thing it would
-- buy is a permanently red `db:drift` — the merge gate that catches the schema
-- drifting away from what is reviewed. A plain UNIQUE including `status` is not
-- a substitute either: it blocks the second decline of a pair that was declined
-- once before.
--
-- So the check lives in `baaki_request_member_claim` instead. The window it
-- leaves is a double-tap producing two identical pending rows, and approving
-- either one declines the rest of the pending claims on that member.
CREATE INDEX IF NOT EXISTS member_claims_group_id_status_created_at_idx
  ON public.member_claims (group_id, status, created_at);

CREATE INDEX IF NOT EXISTS member_claims_requester_id_created_at_idx
  ON public.member_claims (requester_id, created_at);

ALTER TABLE public.member_claims ENABLE ROW LEVEL SECURITY;

-- Readable by the two sides of it and nobody else: the person who asked, and
-- the admins of the group being asked. Deliberately not every member — a
-- declined claim is somebody having been told they are not who they said, and
-- that does not belong in front of the whole group.
DROP POLICY IF EXISTS member_claims_visible ON public.member_claims;
CREATE POLICY member_claims_visible ON public.member_claims
  FOR SELECT TO authenticated
  USING (
    requester_id = public.baaki_current_profile_id()
    OR EXISTS (
      SELECT 1 FROM public.group_members gm
       WHERE gm.group_id = member_claims.group_id
         AND gm.profile_id = public.baaki_current_profile_id()
         AND gm.role = 'admin'
         AND gm.left_at IS NULL
    )
  );

-- Every write goes through a function below. A client that can UPDATE this
-- table can approve its own claim, which is the whole thing this migration
-- exists to stop.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.member_claims FROM anon, authenticated;

COMMENT ON TABLE public.member_claims IS
  'Somebody asking to take over a ghost member. Decided by a group admin (ADR-006).';

-- ───────────────────────────────────────────────────────────── asking ──

/**
 * Record a request to take a ghost's place.
 *
 * Service-role only, and takes the profile explicitly: the caller is
 * `invite-accept`, which has already verified a signed invite token. The
 * person asking is not a member of the group yet and has no other standing to
 * be here, so there is nothing for a client-side check to check.
 *
 * Returns a verdict rather than raising, because every refusal is a sentence
 * to show somebody who just tapped their own name.
 */
CREATE OR REPLACE FUNCTION public.baaki_request_member_claim(
  p_group_id   uuid,
  p_member_id  uuid,
  p_profile_id uuid,
  p_name       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member public.group_members%ROWTYPE;
  v_group  text;
  v_id     uuid;
  v_admin  record;
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
  -- second notification to every admin is not. Safe under the `FOR UPDATE` on
  -- the member above, which serialises requests for one place.
  SELECT id INTO v_id
    FROM public.member_claims
   WHERE member_id = p_member_id AND requester_id = p_profile_id AND status = 'pending';

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'claim_id', v_id, 'already_pending', true);
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

REVOKE ALL ON FUNCTION public.baaki_request_member_claim(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_request_member_claim(uuid, uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_request_member_claim(uuid, uuid, uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────── deciding ──

/**
 * An admin says yes or no.
 *
 * The approval is the claim: one UPDATE moves the ghost row to the person, so
 * every share, payment and settlement already filed against that name comes
 * with it and nothing is copied. `.profile_id IS NULL` in the WHERE is what
 * makes two admins approving at the same moment safe — the second one changes
 * no rows and is told the place is taken.
 *
 * Rejecting a claim is not a smaller version of approving it. Somebody is
 * waiting on an answer either way, so both paths notify.
 */
CREATE OR REPLACE FUNCTION public.baaki_decide_member_claim(
  p_claim_id uuid,
  p_approve  boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile   uuid := public.baaki_current_profile_id();
  v_claim     public.member_claims%ROWTYPE;
  v_admin_id  uuid;
  v_group     text;
  v_ghost     text;
  v_moved     integer;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;

  SELECT * INTO v_claim FROM public.member_claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NO_SUCH_CLAIM');
  END IF;

  SELECT id INTO v_admin_id
    FROM public.group_members
   WHERE group_id = v_claim.group_id
     AND profile_id = v_profile
     AND role = 'admin'
     AND left_at IS NULL;

  -- Not an admin of this group. The same answer as a claim that does not
  -- exist, so this cannot be used to find out which claims do.
  IF v_admin_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NO_SUCH_CLAIM');
  END IF;

  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_DECIDED', 'status', v_claim.status);
  END IF;

  SELECT name INTO v_group FROM public.groups WHERE id = v_claim.group_id;
  SELECT ghost_name INTO v_ghost FROM public.group_members WHERE id = v_claim.member_id;

  IF NOT p_approve THEN
    UPDATE public.member_claims
       SET status = 'declined', decided_by = v_admin_id, decided_at = now()
     WHERE id = p_claim_id;

    PERFORM public.baaki_notify(
      v_claim.requester_id,
      v_claim.group_id,
      'ghost_claim_declined',
      'Not confirmed',
      COALESCE(v_group, 'The group') || ' did not confirm that place. You can still join as yourself.',
      '/join',
      jsonb_build_object('claim_id', p_claim_id, 'group_name', v_group),
      'claim_declined:' || p_claim_id::text
    );

    RETURN jsonb_build_object('ok', true, 'status', 'declined');
  END IF;

  -- Somebody who joined by another route while this sat waiting must not end
  -- up as two members of one group.
  IF EXISTS (
    SELECT 1 FROM public.group_members
     WHERE group_id = v_claim.group_id
       AND profile_id = v_claim.requester_id
       AND left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_A_MEMBER');
  END IF;

  UPDATE public.group_members
     SET profile_id = v_claim.requester_id,
         ghost_name = NULL,
         joined_via = 'invite_link_claim'
   WHERE id = v_claim.member_id
     AND profile_id IS NULL
     AND left_at IS NULL;

  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NOT_CLAIMABLE');
  END IF;

  -- The name they gave, written only now. `invite-accept` used to set it while
  -- claiming, which meant an unconfirmed stranger could rename their own
  -- profile through a join request. And only over the placeholder: somebody
  -- who named themselves two years ago must not be renamed by a group they
  -- have just joined.
  IF v_claim.requested_name IS NOT NULL THEN
    UPDATE public.profiles
       SET display_name = v_claim.requested_name
     WHERE id = v_claim.requester_id
       AND (display_name IS NULL OR display_name = '' OR display_name = 'Guest');
  END IF;

  UPDATE public.member_claims
     SET status = 'approved', decided_by = v_admin_id, decided_at = now()
   WHERE id = p_claim_id;

  -- Anybody else waiting on the same place has lost it. Leaving them pending
  -- would mean an admin later approving a claim on a member who now belongs to
  -- somebody, and being told NOT_CLAIMABLE with no idea why.
  UPDATE public.member_claims
     SET status = 'declined', decided_by = v_admin_id, decided_at = now()
   WHERE member_id = v_claim.member_id
     AND status = 'pending'
     AND id <> p_claim_id;

  PERFORM public.baaki_notify(
    v_claim.requester_id,
    v_claim.group_id,
    'ghost_claim_approved',
    'You are in ' || COALESCE(v_group, 'the group'),
    'Everything already filed under ' || COALESCE(v_ghost, 'that name') || ' is yours',
    '/group/' || v_claim.group_id::text,
    jsonb_build_object('claim_id', p_claim_id, 'group_name', v_group, 'ghost_name', v_ghost),
    'claim_approved:' || p_claim_id::text
  );

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    v_claim.group_id,
    v_claim.member_id,
    'claimed',
    'member',
    v_claim.member_id,
    jsonb_build_object('via', 'invite_link', 'confirmed_by', v_admin_id)
  );

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'member_id', v_claim.member_id);
END
$$;

REVOKE ALL ON FUNCTION public.baaki_decide_member_claim(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_decide_member_claim(uuid, boolean) TO authenticated, service_role;

-- ─────────────────────────────────────────────── giving up on waiting ──

/**
 * The person who asked, withdrawing.
 *
 * The escape hatch from an admin who never opens the app. Without it somebody
 * can be stuck on a screen that says "waiting" forever, with joining as
 * themselves blocked by their own open request.
 */
CREATE OR REPLACE FUNCTION public.baaki_withdraw_member_claim(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
  v_rows    integer;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;

  UPDATE public.member_claims
     SET status = 'withdrawn', decided_at = now()
   WHERE id = p_claim_id
     AND requester_id = v_profile
     AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_rows = 1);
END
$$;

REVOKE ALL ON FUNCTION public.baaki_withdraw_member_claim(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_withdraw_member_claim(uuid) TO authenticated, service_role;

-- ──────────────────────────────────────────────────────────── reading ──

/**
 * What an admin has been asked.
 *
 * A function rather than a plain select because the answer needs the
 * requester's display name, and a person who is not in the group is not
 * somebody the group can read through RLS.
 */
CREATE OR REPLACE FUNCTION public.baaki_group_member_claims(p_group_id uuid)
RETURNS TABLE (
  id             uuid,
  member_id      uuid,
  ghost_name     text,
  requester_name text,
  requested_name text,
  created_at     timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id,
         c.member_id,
         m.ghost_name,
         p.display_name,
         c.requested_name,
         c.created_at
    FROM public.member_claims c
    JOIN public.group_members m ON m.id = c.member_id
    JOIN public.profiles p      ON p.id = c.requester_id
   WHERE c.group_id = p_group_id
     AND c.status = 'pending'
     AND EXISTS (
       SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = p_group_id
          AND gm.profile_id = public.baaki_current_profile_id()
          AND gm.role = 'admin'
          AND gm.left_at IS NULL
     )
   ORDER BY c.created_at;
$$;

REVOKE ALL ON FUNCTION public.baaki_group_member_claims(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_group_member_claims(uuid) TO authenticated, service_role;

/**
 * What the person waiting can see.
 *
 * Carries the group's name because somebody with a pending claim is not in the
 * group and cannot read its row — and "waiting for approval" without saying
 * which group is not worth showing.
 */
CREATE OR REPLACE FUNCTION public.baaki_my_member_claims()
RETURNS TABLE (
  id          uuid,
  group_id    uuid,
  group_name  text,
  ghost_name  text,
  status      text,
  created_at  timestamptz,
  decided_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.group_id, g.name, m.ghost_name, c.status, c.created_at, c.decided_at
    FROM public.member_claims c
    JOIN public.groups g        ON g.id = c.group_id
    JOIN public.group_members m ON m.id = c.member_id
   WHERE c.requester_id = public.baaki_current_profile_id()
   ORDER BY c.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.baaki_my_member_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_my_member_claims() TO authenticated, service_role;

-- ──────────────────────────────────────────────── the guard's message ──
-- `baaki_guard_membership_columns` refuses a client changing `profile_id` and
-- names `invite-accept` as the way to claim a ghost. That is no longer where
-- it happens, and an error message that sends somebody to the wrong file is
-- worse than a vague one. The rule is unchanged; only the sentence moves.

-- Deliberately NOT `SECURITY DEFINER`, unlike everything else in this file.
-- The guard's first line asks whether `current_user` is a client role, and
-- inside a SECURITY DEFINER function `current_user` is the owner no matter who
-- called — so adding it turns the whole trigger into `RETURN NEW`. It was
-- added here, and `security-hardening.test.ts` failed on the next run with
-- "Expected the statement to be denied, but it succeeded".
CREATE OR REPLACE FUNCTION public.baaki_guard_membership_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a role is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a ghost is claimed by an admin approving a request, not by an update'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a membership cannot move between groups'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;
