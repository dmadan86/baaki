-- A settlement's initiator must be one of its two parties.
--
-- `baaki_record_settlement` checked `is_group_member()` — "may you touch this
-- group" — but never "are you in this payment". Any member could record a
-- settlement between two *other* members. It lands `initiated`, so balances do
-- not move immediately; but `baaki_auto_confirm_settlements` flips any
-- `initiated` row older than 7 days to `auto_confirmed`, which does move them.
-- So an insider could fabricate a payment between two other people, and if the
-- payee never noticed the notification within the week, a real debt was
-- silently zeroed by the cron job.
--
-- Confirmation being social is by design (ADR-007); the *initiator* being
-- unrelated to the payment is not. Every legitimate client flow already has the
-- caller as a party — `settle.tsx` sends `from = me` when I pay and `to = me`
-- when they pay me — so requiring the caller's member id to be one of the two
-- parties rejects only the forged case.
--
-- Signature is unchanged, so CREATE OR REPLACE alone; no DROP, no grant change.
-- The body below is the deployed function with one guard added after the
-- membership check; everything else (mutation-id replay, currency fallback,
-- allocations, activity entry) is untouched.

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
