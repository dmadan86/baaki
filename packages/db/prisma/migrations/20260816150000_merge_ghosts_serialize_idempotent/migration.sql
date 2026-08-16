-- Serialise ghost merges per owner, and make a repeat a true no-op.
--
-- Two problems the union version (20260815190000) left open:
--
--  1. A RACE. The canonical lookup reads ghost_merges, then the union INSERT
--     writes it — read-then-write, not atomic. Two overlapping merges by the
--     same owner ({A,B} and {B,C}) that interleave both see "no existing
--     person" (neither has committed), each mints its own person_id, and the
--     last writer on the shared member B wins — leaving A on one identity and C
--     on another, the very split the union was meant to prevent. An
--     owner-scoped transaction advisory lock makes all of one owner's merges
--     run one at a time, so the second sees the first's committed person_id and
--     unions onto it. Different owners never contend (only a hash collision
--     could make them wait, which is harmless).
--
--  2. NOT REALLY IDEMPOTENT. The upsert set `created_at = now()` and fired on
--     every conflicting row even when nothing changed, so merging the same set
--     twice rewrote created_at and — because the sync trigger stamps on UPDATE —
--     bumped updated_seq, re-propagating an unchanged row to every device. The
--     conflict clause now keeps the original created_at and only updates when
--     the person_id or the name actually differs, so a true repeat touches
--     nothing and stamps no new seq. Sync is unaffected: it walks updated_seq
--     (20260816120000), which still advances whenever a real change happens.
--
-- Signature unchanged, so CREATE OR REPLACE (no drop). Everything else — the
-- validation, the all-or-nothing membership check, the transitive union — is
-- verbatim from 20260815190000.

CREATE OR REPLACE FUNCTION public.baaki_merge_ghosts(
  p_member_ids uuid[],
  p_name       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_id uuid := public.baaki_current_profile_id();
  v_name       text := nullif(btrim(coalesce(p_name, '')), '');
  v_canonical  uuid;
  v_count      int;
  v_bad        int;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Serialise this owner's merges for the rest of the transaction, so the
  -- canonical lookup below and the write that follows it are atomic against a
  -- concurrent merge that shares a member. Released on commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('baaki_merge_ghosts:' || v_profile_id::text)::bigint);

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'NAME_REQUIRED: the merged person needs a name'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Distinct, non-null members actually asked for.
  SELECT count(DISTINCT t.id) INTO v_count
    FROM unnest(p_member_ids) AS t(id)
   WHERE t.id IS NOT NULL;

  IF v_count < 2 THEN
    RAISE EXCEPTION 'TOO_FEW: pick at least two people to merge'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every id must be a ghost the caller shares a group with. Anything that is
  -- not — a real person, a member of a group the caller is not in, or an id that
  -- does not exist — makes the whole merge fail rather than merging a subset.
  SELECT count(*) INTO v_bad
    FROM unnest(p_member_ids) AS want(id)
   WHERE want.id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.group_members target
         JOIN public.group_members mine
           ON mine.group_id = target.group_id
          AND mine.profile_id = v_profile_id
          AND mine.left_at IS NULL
        WHERE target.id = want.id
          AND target.profile_id IS NULL
     );

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'NOT_MERGEABLE: every person must be a guest you share a group with'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The members explicitly picked this time.
  CREATE TEMP TABLE _sel ON COMMIT DROP AS
    SELECT DISTINCT m AS member_id
      FROM unnest(p_member_ids) AS m
     WHERE m IS NOT NULL;

  -- Any existing merge groups that overlap the selection: reusing the lowest of
  -- their person_ids (uuid has no min() aggregate, so order and take one) keeps a
  -- repeated merge stable rather than churning. No overlap leaves it NULL.
  SELECT gm.person_id INTO v_canonical
    FROM public.ghost_merges gm
   WHERE gm.owner = v_profile_id
     AND gm.member_id IN (SELECT member_id FROM _sel)
   ORDER BY gm.person_id
   LIMIT 1;

  -- No overlap with a prior merge: this is a brand-new person.
  IF v_canonical IS NULL THEN
    v_canonical := gen_random_uuid();
  END IF;

  -- The full union: the picked members plus every member already sharing a
  -- person_id with any of them, so a transitive merge folds into one identity.
  INSERT INTO public.ghost_merges (owner, member_id, person_id, display_name)
  SELECT v_profile_id, u.member_id, v_canonical, v_name
    FROM (
      SELECT member_id FROM _sel
      UNION
      SELECT gm.member_id
        FROM public.ghost_merges gm
       WHERE gm.owner = v_profile_id
         AND gm.person_id IN (
           SELECT gm2.person_id
             FROM public.ghost_merges gm2
            WHERE gm2.owner = v_profile_id
              AND gm2.member_id IN (SELECT member_id FROM _sel)
         )
    ) AS u(member_id)
  ON CONFLICT (owner, member_id)
  DO UPDATE SET person_id    = EXCLUDED.person_id,
                display_name = EXCLUDED.display_name
  -- Keep created_at, and only write (firing the sync trigger) on a real change,
  -- so an identical re-merge stamps no new updated_seq.
  WHERE ghost_merges.person_id   IS DISTINCT FROM EXCLUDED.person_id
     OR ghost_merges.display_name IS DISTINCT FROM EXCLUDED.display_name;

  RETURN v_canonical;
END
$$;
