-- Per-group balances for one person, for the Friends person-detail screen.
--
-- `baaki_people_i_owe` collapses a person to one row per currency across every
-- group, which is what the Friends list wants. Tapping a person who spans more
-- than one group had nowhere to go — a single `only_group_id` is null once the
-- balance is a sum of several — so this returns the same person un-collapsed:
-- one row per (group, currency), named by the same `person_key` the list uses.
--
-- It is the same identity resolution and the same viewer-scoped edges as
-- `baaki_people_i_owe` (SECURITY INVOKER, keyed off `baaki_current_profile_id()`
-- and RLS on pairwise_balances), so a caller can only ever see their own
-- balances and their own ghost merges. The only differences are that it filters
-- to one `person_key` and groups by group rather than folding groups together.

CREATE OR REPLACE FUNCTION public.baaki_person_group_balances(p_person_key text)
RETURNS TABLE (
  group_id     uuid,
  group_name   text,
  cover_emoji  text,
  currency     char(3),
  net          bigint,
  is_ghost     boolean,
  display_name text
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
  named AS (
    SELECT
      e.group_id,
      e.currency,
      e.net,
      -- The same key the list rolls people up under: a profile id is proof of
      -- one human; a ghost merge is the caller's own proof; failing both, a
      -- ghost stays keyed to its own group membership.
      COALESCE(gm.profile_id::text, mrg.person_id::text, gm.id::text) AS person_key,
      COALESCE(p.display_name, mrg.display_name, gm.ghost_name, 'Someone') AS display_name,
      gm.profile_id IS NULL AS is_ghost
    FROM edges e
    JOIN public.group_members gm ON gm.id = e.other_member_id
    LEFT JOIN public.profiles p ON p.id = gm.profile_id
    LEFT JOIN public.ghost_merges mrg
      ON mrg.member_id = gm.id
     AND mrg.owner = public.baaki_current_profile_id()
  )
  SELECT
    n.group_id,
    g.name         AS group_name,
    g.cover_emoji,
    n.currency,
    sum(n.net)::bigint    AS net,
    bool_and(n.is_ghost)  AS is_ghost,
    max(n.display_name)   AS display_name
  FROM named n
  JOIN public.groups g ON g.id = n.group_id
  WHERE n.person_key = p_person_key
  GROUP BY n.group_id, g.name, g.cover_emoji, n.currency
  HAVING sum(n.net) <> 0
  ORDER BY g.name, n.currency;
$$;

GRANT EXECUTE ON FUNCTION public.baaki_person_group_balances(text) TO authenticated, anon;
