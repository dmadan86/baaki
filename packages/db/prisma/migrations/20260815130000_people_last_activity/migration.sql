-- baaki_people_i_owe gains last_activity_at: the most recent moment you had
-- dealings with a person, so the Friends list can offer a "by date" sort
-- alongside "by amount" and "by name".
--
-- "Activity with a person" is the newest of: an expense version where that
-- member paid or had a share, or a settlement they were either side of, across
-- the groups you share. SECURITY INVOKER is unchanged, so the caller's RLS
-- still limits every row scanned here to groups they belong to — this exposes
-- no timestamp from a group you cannot already see.
--
-- Adding an output column changes the function's return type, which
-- CREATE OR REPLACE refuses ("cannot change return type of existing function")
-- — so drop it first. Nothing in the schema depends on it (the app calls it by
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
      COALESCE(gm.profile_id::text, gm.id::text) AS person_key,
      COALESCE(p.display_name, gm.ghost_name, 'Someone') AS display_name,
      COALESCE(p.avatar_url, public.baaki_gravatar_url(gm.invite_email)) AS avatar_url,
      gm.profile_id IS NULL AS is_ghost,
      ma.last_activity_at
    FROM edges e
    JOIN public.group_members gm ON gm.id = e.other_member_id
    LEFT JOIN public.profiles p ON p.id = gm.profile_id
    LEFT JOIN member_activity ma ON ma.member_id = gm.id
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
