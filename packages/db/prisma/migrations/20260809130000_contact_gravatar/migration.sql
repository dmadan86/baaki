-- A contact's photo from a public source, when we have an email to ask with.
--
-- Gravatar maps an email to whatever picture its owner has set publicly. We
-- never send the address itself — only its hash, which is what Gravatar's URL
-- scheme is — and only for an address the caller already holds (the one they
-- invited this person at). `d=404` means "no picture, no placeholder": Gravatar
-- returns a 404 rather than a generic silhouette, so the client's avatar falls
-- back to its own initials instead of a stranger's grey head.
--
-- This fills `avatar_url` where a person has no profile photo of their own, so
-- it flows to every people-list the app already renders without a client
-- change. A joined member's own email lives in the auth schema this INVOKER
-- function cannot read, so the fallback is the invite email — exactly the
-- "somebody I added by email" case.

CREATE OR REPLACE FUNCTION public.baaki_gravatar_url(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_email IS NULL OR btrim(p_email) = '' THEN NULL
    ELSE 'https://www.gravatar.com/avatar/' || md5(lower(btrim(p_email))) || '?d=404&s=200'
  END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_gravatar_url(text) TO authenticated, anon;

-- Replace the people list to fall back to a Gravatar when the counterparty has
-- no profile picture. Only the `avatar_url` expression changes; everything else
-- is the function as it stood.
CREATE OR REPLACE FUNCTION public.baaki_people_i_owe()
RETURNS TABLE (
  person_key      text,
  profile_id      uuid,
  member_id       uuid,
  display_name    text,
  avatar_url      text,
  is_ghost        boolean,
  currency        char(3),
  net             bigint,
  group_count     int,
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
      COALESCE(gm.profile_id::text, gm.id::text) AS person_key,
      COALESCE(p.display_name, gm.ghost_name, 'Someone') AS display_name,
      -- The one change: a person's own photo, else one from the email we have.
      COALESCE(p.avatar_url, public.baaki_gravatar_url(gm.invite_email)) AS avatar_url,
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
  HAVING sum(n.net) <> 0
  ORDER BY abs(sum(n.net)) DESC, max(n.display_name);
$$;

GRANT EXECUTE ON FUNCTION public.baaki_people_i_owe() TO authenticated, anon;
