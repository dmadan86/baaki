-- Claiming a line on a receipt, with four people doing it at once.
--
-- **Why this is a CRDT and the ledger is not.**
--
-- A conflict-free replicated type guarantees that everybody ends up with the
-- same value. It does not guarantee the value is one anybody intended, and for
-- money that difference is the whole game. Merge two concurrent edits of a
-- split field by field and you get shares that sum to a number nobody chose —
-- convergent, auditable, and wrong. So expenses do not merge: they use
-- optimistic concurrency on `base_version_no`, keep every version (ADR-004),
-- and tell the group who superseded whom. Refusing to merge is the correct
-- behaviour there, and swapping it for a CRDT would be a downgrade.
--
-- Claiming items off a receipt is the opposite kind of problem. Four people
-- round a table tapping the dishes they ate is a *set*, each element owned by
-- the person who added it, and there is no intent to lose — A claiming the
-- biryani and B claiming the naan at the same instant is not a conflict at all,
-- it is two facts. That is exactly what a CRDT is for.
--
-- **The shape: an observed-remove set, add-wins.**
--
-- The obvious design — a row per (receipt, item, member), delete to unclaim —
-- is a 2P-Set and does not converge: A unclaims while B is offline, B's queued
-- re-claim arrives afterwards, and whether the claim survives depends on
-- arrival order. Worse, "replace my claims" done as delete-then-insert loses
-- other people's rows if two of those overlap.
--
-- So a claim is never deleted. It is tombstoned with `released_at`, and
-- re-claiming clears the tombstone. Concurrent claim and unclaim resolve to
-- **claim** — add-wins — because the failure modes are not symmetric: a claim
-- that should have been dropped is visible on screen and costs one more tap,
-- while a claim that vanishes silently takes somebody's dinner off their bill
-- and puts it on everybody else's.

ALTER TABLE public.receipt_item_claims
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  /**
   * Lamport-ish counter, per (receipt, item, member). Every claim or release
   * bumps it, and a write only lands if it is newer than what is already
   * there. Two devices that both think they are at 3 do not fight forever: the
   * one that arrives second reads 3, writes 4, and both converge on it.
   *
   * Wall-clock time would be the obvious alternative and is the wrong one —
   * phones round a dinner table disagree by minutes, and the person with the
   * fast clock would win every race.
   */
  ADD COLUMN IF NOT EXISTS revision int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS receipt_item_claims_live_idx
  ON public.receipt_item_claims (receipt_id, item_index)
  WHERE released_at IS NULL;

-- ─────────────────────────────────────────────────────────── claiming ──

/**
 * Claim or release one line, converging whatever else is happening.
 *
 * Always claims for the **caller**: `member_id` is resolved here rather than
 * taken as an argument, because "which row is about me" is not a question a
 * client gets to answer — the same rule the security audit left behind about
 * `actor_member_id` and `from_member_id`.
 */
CREATE OR REPLACE FUNCTION public.baaki_set_item_claim(
  p_receipt_id uuid,
  p_item_index int,
  p_claimed    boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_member   uuid;
  v_revision int;
BEGIN
  SELECT group_id INTO v_group_id FROM public.receipts WHERE id = p_receipt_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such receipt' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_member := public.baaki_my_member_id(v_group_id);
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_item_index < 0 THEN
    RAISE EXCEPTION 'INVALID_ITEM: an item index is not negative'
      USING ERRCODE = 'check_violation';
  END IF;

  -- One statement, so two devices racing on the same row serialise in the
  -- database rather than in whichever of them read first. The unique index on
  -- (receipt, item, member) is what makes the conflict target exist, and the
  -- revision is what makes the resolution deterministic rather than
  -- last-to-arrive.
  INSERT INTO public.receipt_item_claims (receipt_id, item_index, member_id, released_at, revision)
  VALUES (
    p_receipt_id, p_item_index, v_member,
    CASE WHEN p_claimed THEN NULL ELSE now() END,
    1
  )
  ON CONFLICT (receipt_id, item_index, member_id) DO UPDATE
    SET released_at = CASE WHEN p_claimed THEN NULL ELSE now() END,
        revision    = public.receipt_item_claims.revision + 1,
        updated_at  = now()
  RETURNING revision INTO v_revision;

  RETURN jsonb_build_object(
    'receiptId', p_receipt_id,
    'itemIndex', p_item_index,
    'memberId', v_member,
    'claimed', p_claimed,
    'revision', v_revision
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_set_item_claim(uuid, int, boolean)
  TO authenticated, anon;

/**
 * Who has claimed what, right now.
 *
 * Tombstoned rows are left out here rather than deleted, so a release survives
 * as evidence that somebody chose to let go of a line — and so a device that
 * has been offline can tell "never claimed" from "claimed then released".
 */
CREATE OR REPLACE FUNCTION public.baaki_item_claims(p_receipt_id uuid)
RETURNS TABLE (item_index int, member_id uuid, revision int)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT c.item_index, c.member_id, c.revision
  FROM public.receipt_item_claims c
  WHERE c.receipt_id = p_receipt_id AND c.released_at IS NULL
  ORDER BY c.item_index, c.member_id;
$$;

GRANT EXECUTE ON FUNCTION public.baaki_item_claims(uuid) TO authenticated, anon;

-- ────────────────────────────────────────────────── closing the old door ──
--
-- The direct INSERT and DELETE policies came from M4, before there was an RPC.
-- They let a client write a claim naming any member of the group, which is the
-- `actor_member_id` bug again, and DELETE is what made the set a 2P-Set that
-- cannot converge. Both go; `baaki_set_item_claim` is the only way in.

DROP POLICY IF EXISTS receipt_item_claims_insert ON public.receipt_item_claims;
DROP POLICY IF EXISTS receipt_item_claims_delete ON public.receipt_item_claims;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.receipt_item_claims FROM anon, authenticated;
