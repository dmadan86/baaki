-- Make ghost merges union instead of overwrite, so overlapping merges converge.
--
-- 20260815160000 minted a fresh person_id every call and upserted only the
-- members passed in. That splits a prior merge the moment a new one shares a
-- member with it: merge {A,B} → P1, then merge {B,C} → P2 leaves A on P1 while
-- B and C move to P2 — A silently drops out of the person it was merged into,
-- and the same set merged twice churns its person_id. A viewer's mental model
-- is "these are all one human", which is a union, not a replace.
--
-- The fix pulls in every member already sharing a person_id with any selected
-- member, and assigns the whole union ONE canonical person_id — reusing an
-- existing one when present so a repeat is stable (idempotent grouping) and a
-- transitive merge collapses to a single Friends total. baaki_people_i_owe is
-- unchanged: it already keys on person_id, so a correct assignment is all it
-- needs.
--
-- Note on cycles/self-reference: not representable here. member_id (a
-- group_member) and person_id (a synthetic identity) are different namespaces,
-- and person_id is server-minted, never a member_id — there is no member→member
-- edge to close into a cycle, so there is nothing to reject.

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

  -- Any existing merge groups that overlap the selection: reusing the smallest
  -- of their person_ids keeps a repeated merge stable rather than churning.
  SELECT min(gm.person_id) INTO v_canonical
    FROM public.ghost_merges gm
   WHERE gm.owner = v_profile_id
     AND gm.member_id IN (SELECT member_id FROM _sel);

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
  DO UPDATE SET person_id = EXCLUDED.person_id,
                display_name = EXCLUDED.display_name,
                created_at = now();

  RETURN v_canonical;
END
$$;
