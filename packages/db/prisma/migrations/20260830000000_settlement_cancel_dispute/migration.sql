-- Cancel and dispute for pending settlements.
--
-- The state machine (baaki_settlement_transition) has always permitted
-- `initiated → cancelled` and `initiated → disputed`, and the SettlementStatus
-- enum has carried both values since the baseline — but no RPC ever moved a row
-- there, so the only thing a party could do with a recorded payment was confirm
-- it (or wait for the 7-day auto-confirm). This adds the two missing verbs:
--
--   * the PAYER can cancel a claim they recorded (a mistaken or duplicate entry);
--   * the PAYEE can dispute a claim ("that money never reached me").
--
-- Balance effects (see @waves/core isSettled — only confirmed/auto_confirmed
-- clear a debt, and the canTransition table that already permits these moves):
--   * cancel only reaches an `initiated` row, which was never counted as
--     settled, so it moves no balance — it just retires the pending claim and
--     stops the auto-confirm clock.
--   * dispute of an `initiated` row is likewise balance-neutral.
--   * dispute of an `auto_confirmed` row DOES reopen the debt, and that is the
--     point: the 7-day cron confirmed a payment the payee now says never
--     arrived, so the money is owed again until they settle it for real. The
--     state machine keeps a recovery path (disputed -> confirmed / cancelled)
--     for when the two sort it out.
-- Each is party-scoped like baaki_confirm_settlement, and idempotent so a
-- replayed offline mutation is a no-op rather than a batch-failing error.

--
-- Name: baaki_cancel_settlement(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.baaki_cancel_settlement(p_settlement_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_from     uuid;
  v_status   public."SettlementStatus";
  v_actor    uuid;
BEGIN
  SELECT group_id, from_member_id, status INTO v_group_id, v_from, v_status
  FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.baaki_my_member_id(v_group_id);
  -- Only the payer withdraws their own claim. The payee's tool is dispute — the
  -- mirror image, so neither party can silently erase the other's record.
  IF v_actor IS NULL OR v_actor <> v_from THEN
    RAISE EXCEPTION 'NOT_THE_PAYER: only the person who recorded the payment can cancel it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Idempotent replay: an offline mutation that already landed cancels nothing
  -- a second time. Returns rather than re-writing so the activity log stays at
  -- one entry per real action.
  IF v_status = 'cancelled' THEN
    RETURN;
  END IF;

  -- Only a still-pending claim can be pulled. A confirmed settlement has cleared
  -- a debt somebody agreed to; unwinding that is a new expense, not a cancel.
  IF v_status <> 'initiated' THEN
    RAISE EXCEPTION 'NOT_CANCELLABLE: only a pending settlement can be cancelled'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.settlements SET status = 'cancelled' WHERE id = p_settlement_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_actor, 'cancelled', 'settlement', p_settlement_id, '{}'::jsonb);
END
$$;

--
-- Name: baaki_dispute_settlement(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.baaki_dispute_settlement(p_settlement_id uuid, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_to       uuid;
  v_status   public."SettlementStatus";
  v_actor    uuid;
BEGIN
  SELECT group_id, to_member_id, status INTO v_group_id, v_to, v_status
  FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.baaki_my_member_id(v_group_id);
  -- Only the payee disputes: disputing is saying "the money never reached me",
  -- which only the person who was supposed to receive it can honestly claim.
  IF v_actor IS NULL OR v_actor <> v_to THEN
    RAISE EXCEPTION 'NOT_THE_PAYEE: only the person who was paid can dispute this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_status = 'disputed' THEN
    RETURN;  -- idempotent replay
  END IF;

  -- The trigger permits initiated/auto_confirmed → disputed; a manually
  -- confirmed or already-cancelled row is out of reach.
  IF v_status NOT IN ('initiated', 'auto_confirmed') THEN
    RAISE EXCEPTION 'NOT_DISPUTABLE: this settlement can no longer be disputed'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.settlements SET status = 'disputed' WHERE id = p_settlement_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    v_group_id, v_actor, 'settle_disputed', 'settlement', p_settlement_id,
    CASE WHEN p_reason IS NULL OR btrim(p_reason) = ''
         THEN '{}'::jsonb
         ELSE jsonb_build_object('reason', btrim(p_reason)) END
  );
END
$$;

--
-- ACL — party-checked internally, callable by any signed-in caller and by the
-- sync edge (service_role), exactly like baaki_confirm_settlement.
--

REVOKE ALL ON FUNCTION public.baaki_cancel_settlement(p_settlement_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.baaki_cancel_settlement(p_settlement_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.baaki_cancel_settlement(p_settlement_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.baaki_dispute_settlement(p_settlement_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.baaki_dispute_settlement(p_settlement_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.baaki_dispute_settlement(p_settlement_id uuid, p_reason text) TO service_role;
