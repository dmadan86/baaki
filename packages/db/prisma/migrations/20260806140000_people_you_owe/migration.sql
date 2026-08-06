-- "Who do I owe, and who owes me" — across every group (TDR §5).
--
-- Two things this deliberately does not do, both because doing them would
-- produce a confident wrong number.
--
-- It does not sum across currencies. A person can owe you ₹500 and be owed €20;
-- there is no honest single total without a rate, and inventing one here would
-- put an unreproducible conversion in front of somebody as if it were a fact
-- (ADR-003). Each currency is its own row.
--
-- It does not merge ghosts across groups. A ghost called "Ravi" in your Goa
-- group and a ghost called "Ravi" in your flat group are two records with no
-- evidence they are one human — matching them on name would silently merge two
-- people's debts, and un-merging afterwards is not possible. Only members with
-- a profile are identified across groups, because a profile id is proof.
-- A ghost therefore appears once per group, which is also the truth about what
-- is known.

CREATE OR REPLACE FUNCTION public.baaki_people_i_owe()
RETURNS TABLE (
  /** Stable key: the profile id for a real person, else the member id. */
  person_key      text,
  profile_id      uuid,
  member_id       uuid,
  display_name    text,
  avatar_url      text,
  is_ghost        boolean,
  currency        char(3),
  /** Positive: they owe you. Negative: you owe them. */
  net             bigint,
  group_count     int,
  /** Only set when this person is known in exactly one group, so the UI can link there. */
  only_group_id   uuid
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
  -- Both directions, normalised so a row always reads "what this counterparty
  -- is to me". RLS on pairwise_balances already limits this to my groups.
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
      gm.id            AS member_id,
      gm.profile_id,
      -- A profile id is proof of one human; a ghost name is not, so a ghost
      -- stays keyed to its own group.
      COALESCE(gm.profile_id::text, gm.id::text) AS person_key,
      COALESCE(p.display_name, gm.ghost_name, 'Someone') AS display_name,
      p.avatar_url,
      gm.profile_id IS NULL AS is_ghost
    FROM edges e
    JOIN public.group_members gm ON gm.id = e.other_member_id
    LEFT JOIN public.profiles p ON p.id = gm.profile_id
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
         THEN max(n.group_id::text)::uuid END           AS only_group_id
  FROM named n
  GROUP BY n.person_key, n.currency
  -- Settled up is not a debt. Showing a row of zero would make a list of
  -- everybody you have ever split with, which is not the question being asked.
  HAVING sum(n.net) <> 0
  ORDER BY abs(sum(n.net)) DESC, max(n.display_name);
$$;

GRANT EXECUTE ON FUNCTION public.baaki_people_i_owe() TO authenticated, anon;
