-- ============================================================================
-- M1 — core ledger, online.
--
--   1. auth.users → profiles mirror (Supabase only; skipped on bare Postgres)
--   2. helpers: my member id in a group
--   3. group creation as one atomic, authorized operation
--   4. soft delete / restore with an activity trail (ADR-004)
--   5. activity log writers
--   6. realtime publication for the group channel
--
-- Everything here is guarded so the same migration applies to the plain
-- Postgres CI uses, which has no `auth` schema and no supabase_realtime
-- publication.
-- ============================================================================

-- ────────────────────────────────── 1. profiles mirror auth.users ──

CREATE OR REPLACE FUNCTION public.baaki_handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url, locale)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(NEW.raw_user_meta_data ->> 'display_name', ''),
      NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''),
      NULLIF(NEW.raw_user_meta_data ->> 'name', ''),
      -- ADR-006: anonymous guests get an account too, just an unnamed one.
      'Guest'
    ),
    NEW.raw_user_meta_data ->> 'avatar_url',
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'locale', ''), 'en')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) THEN
    DROP TRIGGER IF EXISTS baaki_on_auth_user_created ON auth.users;
    CREATE TRIGGER baaki_on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.baaki_handle_new_user();
  END IF;
END
$$;

-- ─────────────────────────────────────────────── 2. member helpers ──

/** The caller's member row in a group, or NULL if they are not in it. */
CREATE OR REPLACE FUNCTION public.baaki_my_member_id(p_group_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT gm.id
  FROM public.group_members gm
  WHERE gm.group_id = p_group_id
    AND gm.profile_id = public.baaki_current_profile_id()
    AND gm.left_at IS NULL
  LIMIT 1
$$;

-- ─────────────────────────────────────────── 3. create a group ──
-- Creating a group and becoming its admin is one operation; doing it in two
-- client round-trips would leave orphan groups nobody can see.

CREATE OR REPLACE FUNCTION public.baaki_create_group(
  p_name text,
  p_type text DEFAULT 'other',
  p_currency char(3) DEFAULT 'INR',
  p_emoji text DEFAULT NULL,
  p_simplify boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_id uuid := public.baaki_current_profile_id();
  v_group_id   uuid;
  v_member_id  uuid;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: a group needs an owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile_id) THEN
    RAISE EXCEPTION 'NO_PROFILE: profile % does not exist', v_profile_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF coalesce(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'INVALID_NAME: a group needs a name' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.groups (name, type, default_currency, cover_emoji, simplify_debts, created_by)
  VALUES (trim(p_name), p_type::"GroupType", upper(p_currency), p_emoji, p_simplify, v_profile_id)
  RETURNING id INTO v_group_id;

  INSERT INTO public.group_members (group_id, profile_id, role, joined_via)
  VALUES (v_group_id, v_profile_id, 'admin', 'creator')
  RETURNING id INTO v_member_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'created', 'group', v_group_id,
          jsonb_build_object('name', trim(p_name)));

  RETURN v_group_id;
END
$$;

-- ──────────────────────────────── 4. soft delete and restore ──
-- ADR-004: nothing is ever hard-deleted, and both directions are logged so the
-- group can see who removed what.

CREATE OR REPLACE FUNCTION public.baaki_delete_expense(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id  uuid;
  v_member_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in this group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_member_id := public.baaki_my_member_id(v_group_id);

  UPDATE public.expenses
     SET deleted_at = now(), deleted_by = v_member_id
   WHERE id = p_expense_id AND deleted_at IS NULL;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'deleted', 'expense', p_expense_id, '{}'::jsonb);
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_restore_expense(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id  uuid;
  v_member_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in this group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_member_id := public.baaki_my_member_id(v_group_id);

  -- The 30-day window is enforced by the expenses_restore_window trigger.
  UPDATE public.expenses
     SET deleted_at = NULL, deleted_by = NULL
   WHERE id = p_expense_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'restored', 'expense', p_expense_id, '{}'::jsonb);
END
$$;

-- ───────────────────────────────────────── 5. settlement recording ──
-- Cash / bank settlements in M1; the UPI intent flow reuses the same rows.

CREATE OR REPLACE FUNCTION public.baaki_record_settlement(
  p_group_id uuid,
  p_from_member_id uuid,
  p_to_member_id uuid,
  p_amount bigint,
  p_method text,
  p_currency char(3) DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_client_mutation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settlement_id uuid;
  v_currency      char(3);
  v_actor         uuid;
  v_allocation    jsonb;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in this group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: settle a positive amount' USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying the same mutation must not create a second settlement (ADR-005).
  IF p_client_mutation_id IS NOT NULL THEN
    SELECT id INTO v_settlement_id
    FROM public.settlements WHERE client_mutation_id = p_client_mutation_id;
    IF v_settlement_id IS NOT NULL THEN
      RETURN v_settlement_id;
    END IF;
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  INSERT INTO public.settlements
    (group_id, from_member_id, to_member_id, currency, amount, method, status, note,
     client_mutation_id)
  VALUES
    (p_group_id, p_from_member_id, p_to_member_id, upper(v_currency), p_amount,
     p_method::"SettlementMethod", 'initiated', p_note, p_client_mutation_id)
  RETURNING id INTO v_settlement_id;

  FOR v_allocation IN SELECT * FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb))
  LOOP
    INSERT INTO public.settlement_allocations (settlement_id, expense_id, amount)
    VALUES (
      v_settlement_id,
      (v_allocation ->> 'expenseId')::uuid,
      (v_allocation ->> 'amount')::bigint
    )
    ON CONFLICT (settlement_id, expense_id)
    DO UPDATE SET amount = public.settlement_allocations.amount + EXCLUDED.amount;
  END LOOP;

  v_actor := public.baaki_my_member_id(p_group_id);
  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (p_group_id, v_actor, 'settled', 'settlement', v_settlement_id,
          jsonb_build_object('amount', p_amount, 'currency', v_currency, 'method', p_method));

  RETURN v_settlement_id;
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_confirm_settlement(p_settlement_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_to       uuid;
  v_actor    uuid;
BEGIN
  SELECT group_id, to_member_id INTO v_group_id, v_to
  FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.baaki_my_member_id(v_group_id);
  -- Only the payee confirms receipt. The payer saying "trust me" is exactly
  -- the hole the confirm step exists to close (ADR-007).
  IF v_actor IS NULL OR v_actor <> v_to THEN
    RAISE EXCEPTION 'NOT_THE_PAYEE: only the person who was paid can confirm'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.settlements SET status = 'confirmed' WHERE id = p_settlement_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_actor, 'confirmed', 'settlement', p_settlement_id, '{}'::jsonb);
END
$$;

GRANT EXECUTE ON FUNCTION
  public.baaki_create_group(text, text, char, text, boolean),
  public.baaki_delete_expense(uuid),
  public.baaki_restore_expense(uuid),
  public.baaki_record_settlement(uuid, uuid, uuid, bigint, text, char, text, jsonb, uuid),
  public.baaki_confirm_settlement(uuid),
  public.baaki_my_member_id(uuid)
TO authenticated, anon;

-- ─────────────────────────────────── 6. realtime group channel ──
-- TDR §1: clients subscribe to Postgres changes for the groups they belong to;
-- RLS still applies to what they actually receive.

DO $$
DECLARE
  v_table text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY ARRAY[
      'groups', 'group_members', 'expenses', 'expense_versions',
      'expense_payers', 'expense_shares', 'settlements',
      'settlement_allocations', 'activity_log', 'group_balances'
    ]
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- Realtime payloads carry the full row so a client can reconcile without a
-- refetch; RLS decides who sees them.
ALTER TABLE public.expenses REPLICA IDENTITY FULL;
ALTER TABLE public.settlements REPLICA IDENTITY FULL;
ALTER TABLE public.group_balances REPLICA IDENTITY FULL;
