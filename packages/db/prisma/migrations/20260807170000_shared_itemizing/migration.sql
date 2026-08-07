-- Splitting one bill from four phones.
--
-- The claims CRDT has existed since the last milestone and nothing has ever
-- called it: the itemize screen kept its lines and its claims in React state,
-- so "who had what" was one person's opinion typed into one device. This is
-- the migration that gives the screen something to talk to.
--
-- Two things are needed beyond what is already there.
--
-- **Somebody has to speak for the people without the app.** A group has ghost
-- members — a name and nothing else, no profile, no phone, no way to tap. The
-- existing `baaki_set_item_claim` resolves the member from the caller and
-- refuses to take one as an argument, which is exactly right for anybody who
-- can answer for themselves and impossible for anybody who cannot. So the
-- argument exists now, and is accepted for precisely one kind of member: one
-- with no profile attached. Claiming a line for a real person who is sitting
-- at the same table with the app open is still not something a client gets to
-- do.
--
-- **The parsed receipt has to be trustworthy.** It was writable by any member
-- of the group, which mattered little while it was read once and forgotten.
-- Now it is the shared list of lines everybody claims against, so a member who
-- can rewrite it can change what everybody else is agreeing to. The edge
-- function that reads receipts writes them through `baaki_record_receipt` with
-- the service role; no client has ever written this table directly, so taking
-- the privilege away breaks nothing and closes the door.

-- ─────────────────────────────────────────── claiming, for somebody else ──

-- `CREATE OR REPLACE` with a new argument does not replace anything: it leaves
-- the old three-argument function in place beside the new one, and every
-- existing call fails with "function ... is not unique". Drop it first.
DROP FUNCTION IF EXISTS public.baaki_set_item_claim(uuid, int, boolean);

CREATE FUNCTION public.baaki_set_item_claim(
  p_receipt_id    uuid,
  p_item_index    int,
  p_claimed       boolean,
  /**
   * Whose claim this is, or NULL for the caller's own — which is what the app
   * sends for everybody who has the app. A member id is only accepted here for
   * a ghost: somebody has to tap for the friend who is not on Baaki, and there
   * is nobody else who can.
   */
  p_for_member_id uuid DEFAULT NULL
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
  v_ghost    boolean;
BEGIN
  SELECT group_id INTO v_group_id FROM public.receipts WHERE id = p_receipt_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such receipt' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_item_index < 0 THEN
    RAISE EXCEPTION 'INVALID_ITEM: an item index is not negative'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_for_member_id IS NULL THEN
    v_member := public.baaki_my_member_id(v_group_id);
    IF v_member IS NULL THEN
      RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    SELECT (profile_id IS NULL) INTO v_ghost
    FROM public.group_members
    WHERE id = p_for_member_id AND group_id = v_group_id AND left_at IS NULL;

    IF v_ghost IS NULL THEN
      RAISE EXCEPTION 'UNKNOWN_MEMBER: that person is not in this group'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NOT v_ghost THEN
      -- The whole point of the CRDT is that everybody claims their own lines.
      -- Letting one phone claim for another is how a set of facts turns back
      -- into one person's opinion, and it is the `actor_member_id` bug wearing
      -- a different hat.
      RAISE EXCEPTION 'NOT_YOURS: they are on Baaki — they claim their own lines'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_member := p_for_member_id;
  END IF;

  -- One statement, so two devices racing on the same row serialise in the
  -- database rather than in whichever of them read first.
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

GRANT EXECUTE ON FUNCTION public.baaki_set_item_claim(uuid, int, boolean, uuid)
  TO authenticated, anon;

-- ─────────────────────────────────────────────────── publishing the lines ──

/**
 * Hand the corrected lines to everybody else, and open the bill for claiming.
 *
 * ADR-008 is that the model proposes and a person confirms, so the scan lands
 * in an editable list and whoever scanned it fixes what was misread. That step
 * has to happen *before* anybody claims, because a claim is stored against a
 * line's index: deleting the second of six lines afterwards would silently move
 * four people's dinners onto somebody else's. So this refuses once a single
 * claim exists, and from that moment the list is what everybody agreed to look
 * at.
 *
 * It writes `parsed`, which no client may write directly — that is the point of
 * routing it through here.
 */
CREATE OR REPLACE FUNCTION public.baaki_publish_receipt_items(
  p_receipt_id uuid,
  p_items      jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.receipts WHERE id = p_receipt_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such receipt' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'INVALID_ITEMS: a bill needs lines' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM public.receipt_item_claims WHERE receipt_id = p_receipt_id) THEN
    RAISE EXCEPTION 'ALREADY_CLAIMING: somebody has started claiming these lines'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.receipts
     SET parsed = jsonb_set(COALESCE(parsed, '{}'::jsonb), '{items}', p_items, true),
         updated_at = now()
   WHERE id = p_receipt_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_publish_receipt_items(uuid, jsonb)
  TO authenticated, anon;

-- ──────────────────────────────────────────── the bills still being split ──

/**
 * The receipts in a group that nobody has turned into an expense yet.
 *
 * This is what makes the shared screen reachable. Without it the second person
 * at the table has no way to arrive at the bill the first person scanned, and
 * the CRDT is plumbing with no tap — which is the thing I criticised about the
 * country column and then very nearly did again.
 */
CREATE OR REPLACE FUNCTION public.baaki_open_receipts(p_group_id uuid)
RETURNS TABLE (
  id         uuid,
  created_at timestamptz,
  parsed     jsonb,
  claimed    int,
  items      int
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    r.id,
    r.created_at,
    r.parsed,
    (
      SELECT count(DISTINCT c.item_index)::int
      FROM public.receipt_item_claims c
      WHERE c.receipt_id = r.id AND c.released_at IS NULL
    ),
    COALESCE(jsonb_array_length(r.parsed -> 'items'), 0)
  FROM public.receipts r
  WHERE r.group_id = p_group_id
    AND r.parse_status IN ('parsed', 'needs_review')
    AND r.parsed IS NOT NULL
    -- Once a version points at the receipt the bill has been split and the
    -- screen is history, not work in progress.
    AND NOT EXISTS (
      SELECT 1 FROM public.expense_versions v WHERE v.receipt_id = r.id
    )
  ORDER BY r.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.baaki_open_receipts(uuid) TO authenticated, anon;

-- ──────────────────────────────────────── nobody rewrites a shared receipt ──

DROP POLICY IF EXISTS receipts_insert ON public.receipts;
DROP POLICY IF EXISTS receipts_update ON public.receipts;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.receipts FROM anon, authenticated;
