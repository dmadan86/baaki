-- Group-scope the receipt recorder (hardening for 20260818170000).
--
-- `baaki_record_receipt` is the single service-role write path for a receipt, so
-- it is the real boundary — the gate `baaki_can_add_receipt` only decides an
-- affordance. Two holes let a caller reference a receipt id that belongs to a
-- DIFFERENT group:
--
--   * the cap-exemption `EXISTS` looked up the id alone, so passing any existing
--     receipt id (from any group) skipped the ceiling; and
--   * `ON CONFLICT (id) DO UPDATE` matched by id alone, so the same forged id
--     would overwrite another group's receipt (its parsed text, status) — a
--     cross-group tamper, even though `group_id` itself was never rewritten.
--
-- The gate already qualifies the exemption by `(id, group_id)` (its update
-- exemption only fires when the receipt is in *this* group); the recorder must
-- do the same, and refuse rather than silently no-op when a conflicting id turns
-- out to belong elsewhere.
--
-- Re-declared whole (CREATE OR REPLACE), idempotent; advisory lock and cap check
-- are the 20260818170000 version, with the id lookups group-qualified and a
-- guard on a conflict that resolves to another group's row.

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
  -- Serialize recording for this group, so the count below and the INSERT are
  -- atomic against a concurrent recorder for the same group (TOCTOU). Keyed on
  -- the group, released on commit/rollback. Same device as the ghost-merge
  -- serialization (20260816150000).
  PERFORM pg_advisory_xact_lock(hashtext('baaki_record_receipt:' || p_group_id::text)::bigint);

  -- The ceiling, enforced at the one insert path. A paid group is exempt; an
  -- update of a receipt that already exists IN THIS GROUP is not a new receipt
  -- and is exempt — the id must belong to p_group_id, or a receipt id borrowed
  -- from another group would slip past the cap.
  IF NOT public.baaki_group_is_paid(p_group_id)
     AND (p_receipt_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM public.receipts
             WHERE id = p_receipt_id AND group_id = p_group_id
          ))
     AND (SELECT count(*) FROM public.receipts WHERE group_id = p_group_id)
         >= public.baaki_receipt_cap()
  THEN
    RAISE EXCEPTION 'RECEIPT_CAP'
      USING ERRCODE = 'check_violation',
            HINT = 'This group has reached its receipt limit; upgrade or add storage to add more.';
  END IF;

  -- Insert, or update only when the conflicting row is already this group's. The
  -- `WHERE receipts.group_id = p_group_id` on the conflict means a forged id that
  -- belongs to another group matches nothing to update and returns no row —
  -- group_id is never rewritten and another group's receipt is never touched.
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
    WHERE receipts.group_id = p_group_id
  RETURNING id INTO v_id;

  -- No row means the id exists but in a different group: the conflict skipped the
  -- INSERT and the group-scoped WHERE skipped the UPDATE. Refuse rather than
  -- return NULL, so a caller cannot probe or touch another group's receipt.
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'RECEIPT_GROUP_MISMATCH'
      USING ERRCODE = 'check_violation',
            HINT = 'That receipt belongs to a different group.';
  END IF;

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
