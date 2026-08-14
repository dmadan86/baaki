-- Consuming an invite must be atomic, or `max_uses` is a suggestion.
--
-- invite-accept read `use_count`, checked it against `max_uses`, and much later
-- wrote `use_count + 1`. Two redemptions of the same still-valid link race
-- through that gap: both read the same count, both pass the check, both insert a
-- membership, both write count+1. A link capped at one use admits two (or ten),
-- so a leaked/shared link is redeemable well past its cap.
--
-- The fix is a single conditional UPDATE that Postgres executes atomically: the
-- row is locked for the increment, and `WHERE use_count < max_uses` is evaluated
-- against the locked row, so exactly one concurrent caller can win the last
-- slot. It also re-checks revocation and expiry, closing the same race on those.
-- Returns true when a slot was taken, false when the link is spent/invalid —
-- the caller treats false exactly like the read-time invalid case.
--
-- service_role only: invite-accept calls it with the service client (the invite
-- row is not visible to the joining user), and no client should reach it.

CREATE OR REPLACE FUNCTION public.baaki_consume_invite(p_invite_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.invites
  SET use_count = use_count + 1
  WHERE id = p_invite_id
    AND revoked_at IS NULL
    AND expires_at > now()
    AND use_count < max_uses
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.baaki_consume_invite(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_consume_invite(uuid) TO service_role;
