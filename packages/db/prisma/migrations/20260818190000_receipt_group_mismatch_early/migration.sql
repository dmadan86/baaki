-- Raise the cross-group receipt id early (refines 20260818180000).
--
-- 20260818180000 made `baaki_record_receipt` safe against a receipt id from
-- another group — the group-scoped ON CONFLICT never overwrites it, and the
-- NULL-RETURNING guard refuses it. But it only refused *after* the cap check, so
-- a foreign id against a group already at cap raised RECEIPT_CAP rather than the
-- accurate RECEIPT_GROUP_MISMATCH, and reported the group's cap state for a
-- receipt that was never in it.
--
-- Decide the group question first: right after the advisory lock, before the
-- cap check, a non-null id that exists in a DIFFERENT group is rejected outright.
-- Valid or null ids fall through to the unchanged cap behaviour. The post-INSERT
-- NULL guard stays as a backstop but is now unreachable for the cross-group case.
--
-- Re-declared whole (CREATE OR REPLACE), idempotent; same REVOKE/GRANT.

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

  -- The group question first: a non-null id that already exists in a DIFFERENT
  -- group is neither a new receipt for this group nor a valid update of one, so
  -- it is refused before the cap is even consulted — an accurate error, and no
  -- report of this group's cap state for a receipt that was never in it.
  IF p_receipt_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.receipts
     WHERE id = p_receipt_id AND group_id <> p_group_id
  ) THEN
    RAISE EXCEPTION 'RECEIPT_GROUP_MISMATCH'
      USING ERRCODE = 'check_violation',
            HINT = 'That receipt belongs to a different group.';
  END IF;

  -- The ceiling, enforced at the one insert path. A paid group is exempt; an
  -- update of a receipt that already exists IN THIS GROUP is not a new receipt
  -- and is exempt.
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
  -- cross-group case is already refused above; this WHERE is the backstop.
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

  -- Backstop: no row means the id exists but in a different group (already caught
  -- above). Refuse rather than return NULL.
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
