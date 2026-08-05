-- M5 — receipt scanning (ADR-008 / TDR §6).
--
-- Two things the ledger needs before a photograph can become an expense: a
-- private place to put the image, and a quota, because unlike the ledger a scan
-- has a real per-call cost (ADR-011 — convenience is monetizable, the ledger
-- never is).

-- ─────────────────────────────────────────────── 1. the scan quota ──
-- 20 free scans per calendar month. Counted from `usage_events`, which already
-- exists as the metering table, so there is no second source of truth about
-- what somebody has used.

CREATE OR REPLACE FUNCTION public.baaki_scans_used_this_month(p_profile_id uuid DEFAULT NULL)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int
  FROM public.usage_events ue
  WHERE ue.profile_id = COALESCE(p_profile_id, public.baaki_current_profile_id())
    AND ue.kind = 'receipt_scan'
    AND ue.created_at >= date_trunc('month', now());
$$;

CREATE OR REPLACE FUNCTION public.baaki_receipt_scan_quota()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'used', public.baaki_scans_used_this_month(),
    'limit', 20,
    'remaining', greatest(0, 20 - public.baaki_scans_used_this_month())
  );
$$;

GRANT EXECUTE ON FUNCTION public.baaki_receipt_scan_quota() TO authenticated, anon;

-- Resolving a member id for a profile other than the JWT's own caller — the
-- edge function acts on behalf of a user it has already authenticated.
CREATE OR REPLACE FUNCTION public.baaki_my_member_id_for(p_group_id uuid, p_profile_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM public.group_members
   WHERE group_id = p_group_id AND profile_id = p_profile_id AND left_at IS NULL
   LIMIT 1;
$$;


-- ─────────────────────────────────── 2. recording a parsed receipt ──
-- Service-role only: the caller has to be the edge function, which owns the
-- model call and has already checked membership and quota (ADR-013).

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

-- ────────────────────────────────────────── 3. the receipts bucket ──
-- Guarded exactly like the group-photos bucket: the `storage` schema belongs to
-- Supabase and does not exist in the plain Postgres image CI runs against.

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the receipts bucket';
    RETURN;
  END IF;

  -- Private. A receipt is a record of what somebody ate and where they were;
  -- it is readable by the group it belongs to and nobody else (ADR-013).
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('receipts', 'receipts', false, 10485760,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "receipts are readable by members" ON storage.objects;
    CREATE POLICY "receipts are readable by members" ON storage.objects
      FOR SELECT TO authenticated, anon
      USING (
        bucket_id = 'receipts'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "receipts are writable by members" ON storage.objects;
    CREATE POLICY "receipts are writable by members" ON storage.objects
      FOR INSERT TO authenticated, anon
      WITH CHECK (
        bucket_id = 'receipts'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "receipts are removable by members" ON storage.objects;
    CREATE POLICY "receipts are removable by members" ON storage.objects
      FOR DELETE TO authenticated, anon
      USING (
        bucket_id = 'receipts'
        AND public.is_group_member(public.baaki_group_from_storage_path(name))
      );
  $policy$;
END
$$;
