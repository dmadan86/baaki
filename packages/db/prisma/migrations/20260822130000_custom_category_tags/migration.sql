-- Custom expense tags — user-defined categories (extends TDR §8).
--
-- Until now the "category" of an expense was one of ten built-ins hard-coded in
-- @waves/core. This lets a person define their OWN tags (a label, an icon and a
-- colour), keep them in a personal catalog they manage in Settings, hide and
-- reorder the built-ins, and tag any group expense or capture with them.
--
-- Two moving parts:
--
--   1. `category_tags` — the per-user catalog. Personal, exactly like `captures`
--      (TDR A34): it syncs under the OWNER, not any group, with a per-owner
--      monotonic `updated_seq` and owner-only RLS. A row is either a CUSTOM tag
--      (builtin_id NULL, carries label/icon/tint) or an OVERRIDE of a built-in
--      (builtin_id set, carries only sort_order + hidden — its label stays in the
--      app's own string table). One table, one unified sort order across both.
--
--   2. `category_meta` — a denormalised snapshot of a custom tag's display
--      (label/icon/colour) written onto the expense version and the capture, so a
--      groupmate who does not have the author's catalog still renders the tag.
--      It is null for built-ins (resolved locally) and never touches the split or
--      the ledger maths — a plain label alongside `category`, like
--      `payment_method` and `receipt_share_url` before it.

-- ─────────────────────────────────────────────── the per-owner counter ──
-- The personal equivalent of `captures_seq`: a monotonic sequence on the owner's
-- profile, taken with UPDATE … RETURNING so its order is the commit order the
-- sync pull depends on.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS category_tags_seq BIGINT NOT NULL DEFAULT 0;

-- ────────────────────────────────────────────────────────── the table ──
CREATE TABLE public.category_tags (
  id            UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- Set → this row overrides a built-in category (its id, e.g. 'food'); the
  -- label lives in the app string table, so only sort_order + hidden matter here.
  -- Null → a custom tag, which carries its own label/icon/tint below.
  builtin_id    TEXT,
  label         TEXT,
  -- An Ionicons glyph name (custom tags only), matching how the built-ins draw.
  icon          TEXT,
  -- One of the six design-system tints (lilac/pink/mint/peach/sky/coral).
  tint          TEXT,
  -- Unified ordering across built-ins and custom tags.
  sort_order    INTEGER NOT NULL DEFAULT 0,
  hidden        BOOLEAN NOT NULL DEFAULT false,
  updated_seq   BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Soft delete, so removing a tag on one device propagates through the cursor
  -- rather than silently vanishing from only one.
  deleted_at    TIMESTAMPTZ(6),
  -- A custom tag has to carry a label; an override never does (only bookkeeping).
  CONSTRAINT category_tags_custom_has_label
    CHECK (builtin_id IS NOT NULL OR label IS NOT NULL)
);

-- At most one override row per built-in per owner, so hide/order state is single.
CREATE UNIQUE INDEX category_tags_owner_builtin_idx
  ON public.category_tags (owner_user_id, builtin_id)
  WHERE builtin_id IS NOT NULL AND deleted_at IS NULL;

-- "Everything since seq N for this owner", cheap — the personal mirror of
-- `captures_owner_user_id_updated_seq_idx`.
CREATE INDEX category_tags_owner_user_id_updated_seq_idx
  ON public.category_tags (owner_user_id, updated_seq);

-- ─────────────────────────────────────── the per-owner seq mechanism ──
CREATE OR REPLACE FUNCTION public.baaki_next_category_tag_seq(p_owner uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.profiles
     SET category_tags_seq = category_tags_seq + 1
   WHERE id = p_owner
   RETURNING category_tags_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_stamp_category_tag_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_seq := public.baaki_next_category_tag_seq(NEW.owner_user_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER category_tags_stamp_seq
  BEFORE INSERT OR UPDATE ON public.category_tags
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_category_tag_seq();

-- ─────────────────────────────────────────────────────────────── RLS ──
-- Owner-only on every command — a catalog has exactly one viewer. `/sync` writes
-- these rows AS THE CALLER, so this policy is the whole gate; it never runs as
-- the service role. Delete is soft (an UPDATE of deleted_at), so no DELETE grant.
ALTER TABLE public.category_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY category_tags_own ON public.category_tags
  FOR ALL TO authenticated
  USING (owner_user_id = public.baaki_current_profile_id())
  WITH CHECK (owner_user_id = public.baaki_current_profile_id());

REVOKE ALL ON public.category_tags FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.category_tags TO authenticated;

-- ────────────────────────────── denormalised tag display on the ledger ──
-- Null for a built-in (resolved from the app's own list); the {label,icon,tint}
-- snapshot for a custom tag, so every viewer renders it without the author's
-- catalog. Never read by any balance — a label, like payment_method beside it.
ALTER TABLE public.expense_versions
  ADD COLUMN IF NOT EXISTS category_meta JSONB;

ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS category_meta JSONB;

-- ───────────────────────── teach the one expense writer the new column ──
-- `baaki_apply_expense` is the sole writer of an expense version (M1, ADR-013),
-- so the snapshot can only be filled by giving that function a new parameter.
-- Adding an argument changes the signature, so the current 20-arg version is
-- dropped explicitly first (the pattern fx / payment-method / receipt-share-url
-- already established). SEC-1: this RPC stays service-role only — a fresh CREATE
-- re-grants EXECUTE to PUBLIC by Supabase's defaults, so it is revoked and
-- re-granted to service_role alone below.
DROP FUNCTION IF EXISTS public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text, text, text
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
  p_receipt_share_url  text DEFAULT NULL,
  p_category_meta      jsonb DEFAULT NULL
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
    (expense_id, version_no, author_member_id, description, category, category_meta, expense_date,
     currency, amount, split_type, split_params, receipt_id, notes, payment_method,
     receipt_share_url, client_mutation_id, fx, source)
  VALUES
    (p_expense_id, v_version_no, p_author_member_id, p_description, p_category, p_category_meta, p_expense_date,
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

-- Service-role only, matching 20260819000000_rpc_boundary_hardening (SEC-1).
REVOKE EXECUTE ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text, text, text, jsonb
) TO service_role;

-- PostgREST caches the schema; tell it the signature changed.
NOTIFY pgrst, 'reload schema';
