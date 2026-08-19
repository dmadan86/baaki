-- Store an owner-shared receipt link on an expense version (E3).
--
-- A receipt image lives only on the owner's device and, if they connected one,
-- their OWN personal cloud — never on Waves (ADR-008, the personal-storage
-- model). This adds ONE optional thing to the ledger: a view-only URL to the
-- owner's own cloud copy, set only when they explicitly opt in to "share receipt
-- with the group". The image still never touches our servers; only this link
-- does, so other members can open the bill from the owner's Drive. It is a plain
-- nullable text label on the version, never part of the split or the ledger
-- maths, exactly like `payment_method` before it — so nothing that reads a
-- balance has to change.
--
-- `baaki_apply_expense` is the one writer of an expense version (M1, ADR-013),
-- so the column can only be filled by teaching that function a new parameter.
-- Adding an argument changes the signature, and CREATE OR REPLACE would then
-- create a SECOND function rather than replacing the first, so the current
-- 19-argument signature is dropped explicitly first — the pattern the fx,
-- Splitwise-import and payment-method migrations already established.
--
-- IMPORTANT (SEC-1, from 20260819000000_rpc_boundary_hardening): this RPC is
-- service-role ONLY. The edge functions (/sync, expense-write) recompute and
-- verify the shares, then call it as the service role; a client reaching it
-- directly would skip that check. A fresh CREATE re-grants EXECUTE to PUBLIC by
-- Supabase's defaults, which client roles inherit — so this migration REVOKEs
-- PUBLIC/anon/authenticated and GRANTs only service_role, matching the intent
-- #274 restored. Re-widening the grant here would silently reopen that hole.

ALTER TABLE public.expense_versions
  ADD COLUMN IF NOT EXISTS receipt_share_url text;

DROP FUNCTION IF EXISTS public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text, text
);

CREATE OR REPLACE FUNCTION public.baaki_apply_expense(
  p_group_id           uuid,
  p_expense_id         uuid,
  p_author_member_id   uuid,
  p_description        text,
  p_category           text,
  p_expense_date       date,
  p_currency           char(3),
  p_amount             bigint,
  p_split_type         text,
  p_split_params       jsonb,
  p_payers             jsonb,
  p_shares             jsonb,
  p_client_mutation_id uuid,
  p_notes              text DEFAULT NULL,
  p_receipt_id         uuid DEFAULT NULL,
  p_base_version_no    int DEFAULT NULL,
  p_fx                 jsonb DEFAULT NULL,
  p_source             text DEFAULT 'manual',
  p_payment_method     text DEFAULT NULL,
  p_receipt_share_url  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing        RECORD;
  v_version_no      int;
  v_version_id      uuid;
  v_is_new          boolean := false;
  v_row             jsonb;
  v_unknown         int;
  v_conflict        boolean := false;
  v_superseded_no   int;
  v_superseded_by   uuid;
  v_superseded_desc text;
  v_group_currency  char(3);
BEGIN
  -- This function is SECURITY DEFINER: verify the caller is a live member of the
  -- group before it moves a balance (security hardening).
  PERFORM public.baaki_assert_expense_caller(p_group_id, p_author_member_id);

  -- Replay of a mutation we already applied (ADR-005).
  IF p_client_mutation_id IS NOT NULL THEN
    SELECT ev.id, ev.expense_id, ev.version_no INTO v_existing
    FROM public.expense_versions ev
    WHERE ev.client_mutation_id = p_client_mutation_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'expenseId', v_existing.expense_id,
        'versionId', v_existing.id,
        'versionNo', v_existing.version_no,
        'replayed', true
      );
    END IF;
  END IF;

  -- A rate that converts the wrong way is worse than no rate: it converts
  -- confidently and wrongly. Checked before a single row is written.
  SELECT g.default_currency INTO v_group_currency FROM public.groups g WHERE g.id = p_group_id;
  PERFORM public.baaki_assert_fx_valid(p_fx, upper(p_currency)::char(3), v_group_currency);

  -- Every member referenced must belong to this group; a caller cannot smuggle
  -- in somebody else's member id (ADR-013).
  SELECT count(*) INTO v_unknown
  FROM (
    SELECT (value ->> 'memberId')::uuid AS member_id FROM jsonb_array_elements(p_payers)
    UNION
    SELECT (value ->> 'memberId')::uuid FROM jsonb_array_elements(p_shares)
    UNION
    SELECT p_author_member_id
  ) referenced
  WHERE referenced.member_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.id = referenced.member_id AND gm.group_id = p_group_id
    );
  IF v_unknown > 0 THEN
    RAISE EXCEPTION 'UNKNOWN_MEMBER: % member(s) are not in this group', v_unknown
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF p_expense_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.expenses WHERE id = p_expense_id) THEN
    v_is_new := true;
    INSERT INTO public.expenses (id, group_id, created_by)
    VALUES (COALESCE(p_expense_id, gen_random_uuid()), p_group_id, p_author_member_id)
    RETURNING id INTO p_expense_id;
    v_version_no := 1;
  ELSE
    IF (SELECT group_id FROM public.expenses WHERE id = p_expense_id) <> p_group_id THEN
      RAISE EXCEPTION 'WRONG_GROUP: that expense belongs to another group'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(max(version_no), 0) + 1 INTO v_version_no
    FROM public.expense_versions WHERE expense_id = p_expense_id;

    -- Somebody else wrote a version after the one this client was looking at.
    -- Append-only means both survive; the later receipt — this one — wins.
    IF p_base_version_no IS NOT NULL AND p_base_version_no < v_version_no - 1 THEN
      v_conflict := true;
      SELECT ev.version_no, ev.author_member_id, ev.description
        INTO v_superseded_no, v_superseded_by, v_superseded_desc
        FROM public.expense_versions ev
        JOIN public.expenses e ON e.id = ev.expense_id AND e.current_version_id = ev.id
       WHERE ev.expense_id = p_expense_id;
    END IF;
  END IF;

  INSERT INTO public.expense_versions
    (expense_id, version_no, author_member_id, description, category, expense_date,
     currency, amount, split_type, split_params, receipt_id, notes, payment_method,
     receipt_share_url, client_mutation_id, fx, source)
  VALUES
    (p_expense_id, v_version_no, p_author_member_id, p_description, p_category, p_expense_date,
     upper(p_currency), p_amount, p_split_type::"SplitType", p_split_params, p_receipt_id,
     p_notes, p_payment_method, p_receipt_share_url, p_client_mutation_id, p_fx,
     COALESCE(p_source, 'manual')::"ExpenseSource")
  RETURNING id INTO v_version_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_payers) LOOP
    INSERT INTO public.expense_payers (expense_version_id, member_id, amount)
    VALUES (v_version_id, (v_row ->> 'memberId')::uuid, (v_row ->> 'amount')::bigint);
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_shares) LOOP
    INSERT INTO public.expense_shares (expense_version_id, member_id, amount)
    VALUES (v_version_id, (v_row ->> 'memberId')::uuid, (v_row ->> 'amount')::bigint);
  END LOOP;

  -- Pointing at the new version is what makes the edit live.
  UPDATE public.expenses SET current_version_id = v_version_id WHERE id = p_expense_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    p_group_id, p_author_member_id,
    CASE WHEN v_is_new THEN 'added' ELSE 'edited' END,
    'expense', p_expense_id,
    jsonb_build_object(
      'description', p_description,
      'amount', p_amount::text,
      'currency', upper(p_currency),
      'versionNo', v_version_no,
      'source', COALESCE(p_source, 'manual')
    )
  );

  -- A second entry, so the person whose edit lost can find it. Their version is
  -- still in `expense_versions` and restoring it is just another edit.
  IF v_conflict THEN
    INSERT INTO public.activity_log
      (group_id, actor_member_id, verb, object_type, object_id, payload)
    VALUES (
      p_group_id, p_author_member_id, 'superseded', 'expense', p_expense_id,
      jsonb_build_object(
        'supersededVersionNo', v_superseded_no,
        'supersededAuthorMemberId', v_superseded_by,
        'supersededDescription', v_superseded_desc,
        'baseVersionNo', p_base_version_no,
        'winningVersionNo', v_version_no
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'expenseId', p_expense_id,
    'versionId', v_version_id,
    'versionNo', v_version_no,
    'replayed', false,
    'superseded', v_conflict,
    'supersededVersionNo', v_superseded_no
  );
END
$$;

-- Service-role only, matching 20260819000000_rpc_boundary_hardening (SEC-1). A
-- fresh CREATE re-grants EXECUTE to PUBLIC by Supabase's defaults, which client
-- roles inherit, so revoke that first, then grant the single legitimate caller.
REVOKE EXECUTE ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text, text, text
) TO service_role;

-- PostgREST caches the schema; tell it the signature changed.
NOTIFY pgrst, 'reload schema';
