-- Merge same-person ghosts across groups (Friends screen).
--
-- The base rule stands: `baaki_people_i_owe` never merges ghosts on name,
-- because a ghost "Ravi" in one group is no proof of the "Ravi" in another, and
-- silently merging two people's debts cannot be undone. What this adds is the
-- one thing name-matching lacks — a *person* saying "these two are the same",
-- which is proof of a different kind. That assertion is:
--
--   * per-viewer. It is my claim about ghosts I split with, recorded against my
--     profile, and it changes only my own Friends aggregation. It never edits
--     the shared `group_members` rows, so another member's view is untouched and
--     no expense, share or settlement is rewritten. Each group keeps its own
--     ghost and its own per-group ledger exactly as before (ADR-004); only the
--     `person_key` those rows roll up under changes, and only for me.
--
--   * recoverable, though the app never offers it. The merge is presented as
--     permanent (there is no un-merge screen), but because it lives in its own
--     table rather than mutating the ledger, a mistaken merge — two genuinely
--     different people who share a name — can still be lifted with a DELETE
--     here. The irreversibility the base rule warns about is the irreversibility
--     of *rewritten debts*; nothing here rewrites a debt.
--
-- The shared identity is `person_id`, a fresh uuid stamped across every ghost in
-- one merge; `display_name` is the name the owner chose for the merged person,
-- carried on each row so the view needs no second join.

CREATE TABLE "ghost_merges" (
    -- Who made the merge. All rows are read and written only by this profile.
    "owner"        UUID NOT NULL,
    -- The ghost `group_members.id` being folded into the merged person.
    "member_id"    UUID NOT NULL,
    -- The shared identity: same value on every ghost in one merge.
    "person_id"    UUID NOT NULL,
    -- The name the owner gave the merged person.
    "display_name" TEXT NOT NULL,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ghost_merges_pkey" PRIMARY KEY ("owner", "member_id"),
    CONSTRAINT "ghost_merges_owner_fkey"
      FOREIGN KEY ("owner") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- A ghost that leaves for good takes its merge row with it.
    CONSTRAINT "ghost_merges_member_id_fkey"
      FOREIGN KEY ("member_id") REFERENCES "group_members"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The view groups by `person_id`, so that is the hot lookup.
CREATE INDEX "ghost_merges_owner_person_id_idx"
  ON "ghost_merges" ("owner", "person_id");

ALTER TABLE "ghost_merges" ENABLE ROW LEVEL SECURITY;

-- A merge is private to the person who made it — theirs to read and theirs to
-- write, nobody else's to see. Membership in the underlying groups is checked in
-- the RPC, not here; this policy only ties every row to its owner.
CREATE POLICY ghost_merges_select_own ON public.ghost_merges
  FOR SELECT TO authenticated, anon
  USING (owner = public.baaki_current_profile_id());
CREATE POLICY ghost_merges_insert_own ON public.ghost_merges
  FOR INSERT TO authenticated, anon
  WITH CHECK (owner = public.baaki_current_profile_id());
CREATE POLICY ghost_merges_update_own ON public.ghost_merges
  FOR UPDATE TO authenticated, anon
  USING (owner = public.baaki_current_profile_id())
  WITH CHECK (owner = public.baaki_current_profile_id());
CREATE POLICY ghost_merges_delete_own ON public.ghost_merges
  FOR DELETE TO authenticated, anon
  USING (owner = public.baaki_current_profile_id());

-- Fold a set of ghosts into one person for the caller's Friends view.
--
-- Deliberately strict, because it writes an identity claim about other people:
--   * at least two members, or there is nothing to merge;
--   * every member must be a ghost (no profile) — a real person is already
--     identified by their profile id and must never be folded under a made-up
--     name;
--   * the caller must share a group with each ghost, so nobody can assert a
--     merge about people they never split with.
-- Re-running with an overlapping set re-stamps those ghosts onto the same fresh
-- person, which is how "add one more" onto an existing merge works.
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
  v_person_id  uuid := gen_random_uuid();
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

  INSERT INTO public.ghost_merges (owner, member_id, person_id, display_name)
  SELECT v_profile_id, picked.id, v_person_id, v_name
    FROM (SELECT DISTINCT m
            FROM unnest(p_member_ids) AS m
           WHERE m IS NOT NULL) AS picked(id)
  ON CONFLICT (owner, member_id)
  DO UPDATE SET person_id = EXCLUDED.person_id,
                display_name = EXCLUDED.display_name,
                created_at = now();

  RETURN v_person_id;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_merge_ghosts(uuid[], text) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_merge_ghosts(uuid[], text) TO authenticated, anon;

-- "Who do I owe, and who owes me" — now honouring the caller's own ghost merges.
-- Everything the current version does is unchanged (per-currency rows, gravatar
-- avatars, the `last_activity_at` sort key, and the refusal to auto-merge on
-- name); the only addition is the left join to `ghost_merges`, which lets a
-- caller-made merge stand in as the proof that two ghosts are one person. Absent
-- a merge, a ghost still keys to its own member id, exactly as before.
--
-- Adding the join does not change the return type, but the function is dropped
-- and recreated rather than replaced to stay consistent with how the previous
-- migration rebuilt it. Nothing in the schema depends on it (the app calls it by
-- RPC), so the drop is clean; the grant is re-issued below.
DROP FUNCTION IF EXISTS public.baaki_people_i_owe();

CREATE FUNCTION public.baaki_people_i_owe()
RETURNS TABLE (
  person_key       text,
  profile_id       uuid,
  member_id        uuid,
  display_name     text,
  avatar_url       text,
  is_ghost         boolean,
  currency         char(3),
  net              bigint,
  group_count      int,
  only_group_id    uuid,
  last_activity_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH me AS (
    SELECT gm.id AS member_id, gm.group_id
      FROM public.group_members gm
     WHERE gm.profile_id = public.baaki_current_profile_id()
       AND gm.left_at IS NULL
  ),
  edges AS (
    SELECT pb.group_id, pb.to_member_id AS other_member_id, pb.currency, -pb.amount AS net
      FROM public.pairwise_balances pb
      JOIN me ON me.group_id = pb.group_id AND me.member_id = pb.from_member_id
    UNION ALL
    SELECT pb.group_id, pb.from_member_id, pb.currency, pb.amount
      FROM public.pairwise_balances pb
      JOIN me ON me.group_id = pb.group_id AND me.member_id = pb.to_member_id
  ),
  -- The newest activity per member, from every place a member leaves a
  -- timestamp: expense versions they paid or shared, and settlements either way.
  member_activity AS (
    SELECT a.member_id, max(a.ts) AS last_activity_at
      FROM (
        SELECT epy.member_id, ev.created_at AS ts
          FROM public.expense_payers epy
          JOIN public.expense_versions ev ON ev.id = epy.expense_version_id
          JOIN public.expenses ex ON ex.id = ev.expense_id AND ex.deleted_at IS NULL
        UNION ALL
        SELECT esh.member_id, ev.created_at
          FROM public.expense_shares esh
          JOIN public.expense_versions ev ON ev.id = esh.expense_version_id
          JOIN public.expenses ex ON ex.id = ev.expense_id AND ex.deleted_at IS NULL
        UNION ALL
        SELECT s.from_member_id, s.created_at FROM public.settlements s
        UNION ALL
        SELECT s.to_member_id, s.created_at FROM public.settlements s
      ) a(member_id, ts)
      GROUP BY a.member_id
  ),
  named AS (
    SELECT
      e.group_id,
      e.currency,
      e.net,
      gm.id            AS member_id,
      gm.profile_id,
      -- A profile id is proof of one human; a ghost merge is the caller's own
      -- proof; failing both, a ghost stays keyed to its own group.
      COALESCE(gm.profile_id::text, mrg.person_id::text, gm.id::text) AS person_key,
      COALESCE(p.display_name, mrg.display_name, gm.ghost_name, 'Someone') AS display_name,
      COALESCE(p.avatar_url, public.baaki_gravatar_url(gm.invite_email)) AS avatar_url,
      gm.profile_id IS NULL AS is_ghost,
      ma.last_activity_at
    FROM edges e
    JOIN public.group_members gm ON gm.id = e.other_member_id
    LEFT JOIN public.profiles p ON p.id = gm.profile_id
    LEFT JOIN member_activity ma ON ma.member_id = gm.id
    LEFT JOIN public.ghost_merges mrg
      ON mrg.member_id = gm.id
     AND mrg.owner = public.baaki_current_profile_id()
  )
  SELECT
    n.person_key,
    max(n.profile_id::text)::uuid                       AS profile_id,
    max(n.member_id::text)::uuid                        AS member_id,
    max(n.display_name)                                 AS display_name,
    max(n.avatar_url)                                   AS avatar_url,
    bool_and(n.is_ghost)                                AS is_ghost,
    n.currency,
    sum(n.net)::bigint                                  AS net,
    count(DISTINCT n.group_id)::int                     AS group_count,
    CASE WHEN count(DISTINCT n.group_id) = 1
         THEN max(n.group_id::text)::uuid END           AS only_group_id,
    max(n.last_activity_at)                             AS last_activity_at
  FROM named n
  GROUP BY n.person_key, n.currency
  HAVING sum(n.net) <> 0
  ORDER BY abs(sum(n.net)) DESC, max(n.display_name);
$$;

GRANT EXECUTE ON FUNCTION public.baaki_people_i_owe() TO authenticated, anon;
