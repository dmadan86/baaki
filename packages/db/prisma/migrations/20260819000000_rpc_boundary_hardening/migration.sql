-- RPC boundary hardening (audit P0)
--
-- Two SECURITY DEFINER money RPCs were reachable straight from PostgREST by
-- client roles and trusted what the client sent.
--
--  SEC-1 (critical): `baaki_apply_expense` was created service-role only
--    (20260804181500_atomic_expense_write: REVOKE ALL FROM PUBLIC, anon,
--    authenticated; GRANT TO service_role) — correct. But every later migration
--    that changed its signature re-granted it "TO authenticated, anon", and the
--    last one (20260818120000_add_person_payment) DROP..CREATE'd it and re-added
--    only that wrong grant, dropping the service_role grant on the way. So the
--    anon key shipped in every app binary (a JWT with role=anon and no `sub`)
--    could call it: `baaki_assert_expense_caller` returns without checking when
--    `baaki_current_profile_id()` is null, which it is for anon.
--  INT-1 (critical): the shares are stored verbatim; only Σpayers=Σshares=amount
--    is checked (a deferred constraint trigger). The recompute that would catch a
--    forged share vector lives in the Deno `sync`/`expense-write` edge functions
--    (both recompute from the split params and verify the client's copy before
--    calling this as the service role) — not in the DB. So a client reaching the
--    RPC directly skipped it.
--  INT-2 (critical): `baaki_record_settlement` never checked that the two parties
--    belong to the settlement's group.
--
-- Fix: restore `baaki_apply_expense` to service-role only (closes SEC-1 and
-- INT-1 together — the edge functions become the only door again), and constrain
-- the settlement parties to the group. The caller assertion's null-profile branch
-- is deliberately left as-is: post-revoke it is reachable only by the service
-- role (edge functions / cron), which is trusted, and tightening it would break
-- the owner-role paths that seed expenses in migrations and tests.

-- ── SEC-1 + INT-1: the expense write RPC is service-role only again ───────────
REVOKE EXECUTE ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text, text
) FROM anon, authenticated;

-- Re-grant the door the edge functions use. The last DROP..CREATE dropped this
-- grant and never restored it; make the intent explicit and current.
GRANT EXECUTE ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text, text
) TO service_role;

-- ── INT-2: settlement parties must belong to the settlement's group ──────────
CREATE OR REPLACE FUNCTION public.baaki_record_settlement(
  p_group_id           uuid,
  p_from_member_id     uuid,
  p_to_member_id       uuid,
  p_amount             bigint,
  p_method             text,
  p_currency           char(3) DEFAULT NULL,
  p_note               text DEFAULT NULL,
  p_allocations        jsonb DEFAULT '[]'::jsonb,
  p_client_mutation_id uuid DEFAULT NULL,
  p_rail               text DEFAULT NULL
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
  v_rail          text := COALESCE(NULLIF(btrim(p_rail), ''), p_method);
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in this group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Resolve the caller's own member id up front: it is both the authorization
  -- check below and the actor on the activity entry further down.
  v_actor := public.baaki_my_member_id(p_group_id);
  IF v_actor IS NULL OR v_actor NOT IN (p_from_member_id, p_to_member_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: you can only record a settlement you are part of'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Both parties must be members of THIS group. The FKs only prove the ids are
  -- real `group_members` rows, not that they belong here — without this a member
  -- could name a party from another group, and auto-confirm would later write an
  -- offsetting balance against a member nobody in this group can see, erasing
  -- their own debt while the per-group sum still totals zero.
  IF NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.id = p_from_member_id AND gm.group_id = p_group_id
      )
     OR NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.id = p_to_member_id AND gm.group_id = p_group_id
      ) THEN
    RAISE EXCEPTION 'UNKNOWN_MEMBER: both parties must be members of this group'
      USING ERRCODE = 'foreign_key_violation';
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
    (group_id, from_member_id, to_member_id, currency, amount, method, rail, status, note,
     client_mutation_id)
  VALUES
    (p_group_id, p_from_member_id, p_to_member_id, upper(v_currency), p_amount,
     CASE WHEN p_method IN ('upi', 'cash', 'bank', 'other') THEN p_method ELSE 'other' END
       ::"SettlementMethod",
     v_rail, 'initiated', p_note, p_client_mutation_id)
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

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (p_group_id, v_actor, 'settled', 'settlement', v_settlement_id,
          jsonb_build_object('amount', p_amount, 'currency', v_currency,
                             'method', p_method, 'rail', v_rail));

  RETURN v_settlement_id;
END
$$;

-- anon is already blocked by is_group_member (a null profile matches no row),
-- but revoke it so the grant matches the intent; authenticated keeps it because
-- the mobile client records settlements through this RPC directly (and /sync
-- calls it as the caller, not the service role).
REVOKE EXECUTE ON FUNCTION public.baaki_record_settlement(
  uuid, uuid, uuid, bigint, text, character, text, jsonb, uuid, text
) FROM anon;

-- PostgREST caches the schema; tell it the permissions/signatures changed.
NOTIFY pgrst, 'reload schema';
