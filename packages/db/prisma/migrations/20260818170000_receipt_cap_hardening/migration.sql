-- Hardening for the per-group receipt cap (20260818160000_receipt_cap).
--
-- Two follow-ups to that migration, both re-declared whole (CREATE OR REPLACE)
-- so this migration is idempotent and safe to re-run:
--
--   E. A TOCTOU race. `baaki_record_receipt` checks the count and then inserts
--      in two steps; two concurrent transactions could both pass the count and
--      both insert, taking an unpaid group one (or more) over its ceiling. The
--      count and the insert must be atomic against a concurrent recorder for
--      the *same group*. A transaction-scoped advisory lock keyed on the group
--      serializes recording per group — the same device the ghost-merge path
--      uses to serialize per owner (20260816150000). Different groups never
--      contend (only a hash collision would, harmlessly).
--
--   F. A re-parse wrongly blocked at the edge. `baaki_can_add_receipt` returned
--      false whenever the group sat at cap, even when the request was
--      re-scanning an *existing* receipt — an update, which the recorder itself
--      correctly allows. The edge function calls this before spending on the
--      model, so at cap a legitimate re-parse was refused with a 429 that the
--      recorder would never have raised. The gate now takes an optional receipt
--      id and mirrors the recorder's update exemption.

-- ─────────────────────────────── may the caller add a receipt ──

/**
 * May the caller attach one more receipt to this group?
 *   * re-parse of an existing receipt (p_receipt_id already in the group)
 *                   → always yes; it is an update, not a new receipt, and the
 *                     recorder lets it through even at cap;
 *   * not a member  → no (and it is not their business how many the group has);
 *   * paid group    → always yes, the cap does not apply;
 *   * otherwise     → yes while the group holds fewer than the cap.
 *
 * `p_receipt_id` defaults to NULL so the existing one-argument callers (the
 * mobile client's `canAddReceipt`, which only knows the group) keep working and
 * keep the new-receipt semantics. A bare boolean, like the photo gate; the real
 * boundary is `baaki_record_receipt`, which enforces the same rule.
 */

-- Drop the previous one-argument overload first. If both it and the new
-- two-argument form (with a defaulted second arg) existed, a one-argument call
-- would match both and Postgres would raise "function is not unique". Removing
-- it makes the defaulted form the sole match for the mobile client's 1-arg call.
DROP FUNCTION IF EXISTS public.baaki_can_add_receipt(uuid);

CREATE OR REPLACE FUNCTION public.baaki_can_add_receipt(
  p_group_id   uuid,
  p_receipt_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
BEGIN
  IF v_profile IS NULL OR p_group_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.profile_id = v_profile
       AND gm.left_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  -- A re-parse of a receipt that already belongs to this group is an update,
  -- never a new row against the ceiling. Exactly the recorder's exemption, so
  -- the gate cannot refuse what the boundary would allow.
  IF p_receipt_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.receipts
     WHERE id = p_receipt_id
       AND group_id = p_group_id
  ) THEN
    RETURN true;
  END IF;

  IF public.baaki_group_is_paid(p_group_id) THEN
    RETURN true;
  END IF;

  RETURN (SELECT count(*) FROM public.receipts WHERE group_id = p_group_id)
         < public.baaki_receipt_cap();
END
$$;

REVOKE ALL ON FUNCTION public.baaki_can_add_receipt(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_can_add_receipt(uuid, uuid) TO authenticated;

-- ──────────────────────── the cap as the real boundary ──
-- Re-declared whole with a per-group transaction advisory lock at the top of
-- the block, before the cap check, held (xact-scoped) through the INSERT. The
-- count and the write are now atomic against a concurrent recorder for the same
-- group, closing the TOCTOU window. Body is otherwise the 20260818160000
-- version unchanged; same REVOKE/GRANT (service_role only).

CREATE OR REPLACE FUNCTION public.baaki_record_receipt(
  p_group_id     uuid,
  p_receipt_id   uuid,
  p_profile_id   uuid,
  p_source       text,
  p_storage_path text,
  p_raw_text     text,
  p_parsed       jsonb,
  p_status       text,
  p_input_tokens int DEFAULT 0,
  p_output_tokens int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Serialize recording for this group. Without it the count below and the
  -- INSERT are two steps: two concurrent callers could both count < cap and
  -- both insert, exceeding the ceiling. Keyed on the group so only same-group
  -- recorders wait; released on commit/rollback. Same lock device as the
  -- ghost-merge serialization (20260816150000).
  PERFORM pg_advisory_xact_lock(hashtext('baaki_record_receipt:' || p_group_id::text)::bigint);

  -- The ceiling, enforced at the one insert path. A paid group is exempt; an
  -- update of a receipt that already exists is not a new receipt and is exempt.
  IF NOT public.baaki_group_is_paid(p_group_id)
     AND (p_receipt_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.receipts WHERE id = p_receipt_id))
     AND (SELECT count(*) FROM public.receipts WHERE group_id = p_group_id)
         >= public.baaki_receipt_cap()
  THEN
    RAISE EXCEPTION 'RECEIPT_CAP'
      USING ERRCODE = 'check_violation',
            HINT = 'This group has reached its receipt limit; upgrade or add storage to add more.';
  END IF;

  INSERT INTO public.receipts
    (id, group_id, storage_path, source, raw_text, parse_status, parsed, created_by)
  VALUES
    (COALESCE(p_receipt_id, gen_random_uuid()), p_group_id, p_storage_path,
     p_source::"ReceiptSource", p_raw_text, p_status::"ParseStatus", p_parsed,
     public.baaki_my_member_id_for(p_group_id, p_profile_id))
  ON CONFLICT (id) DO UPDATE
    SET parsed = excluded.parsed,
        parse_status = excluded.parse_status,
        raw_text = excluded.raw_text
  RETURNING id INTO v_id;

  -- Metered because each scan has a real API cost to watch (ADR-011).
  INSERT INTO public.usage_events
    (profile_id, group_id, kind, input_tokens, output_tokens, metadata)
  VALUES (p_profile_id, p_group_id, 'receipt_scan', p_input_tokens, p_output_tokens,
          jsonb_build_object('receiptId', v_id, 'status', p_status));

  RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_record_receipt(
  uuid, uuid, uuid, text, text, text, jsonb, text, int, int
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_record_receipt(
  uuid, uuid, uuid, text, text, text, jsonb, text, int, int
) TO service_role;
