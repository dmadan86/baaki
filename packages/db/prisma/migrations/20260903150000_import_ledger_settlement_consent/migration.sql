-- An imported settlement needs the same consent a recorded one does.
--
-- `baaki_import_ledger` used to insert settlements exactly as the file
-- described them, `confirmed` by default, with no look at who the parties were.
-- The transition guard only fires on UPDATE, so a row born `confirmed` was
-- never checked by anything: any member could import
-- `{from: me, to: <a member>, amount: <the debt>, status: "confirmed"}` and
-- erase what they owed, without the payee ever seeing it (ADR-007 says the
-- payee confirms; `baaki_record_settlement` writes `initiated` for that
-- reason).
--
-- The rule now: a settlement lands `confirmed` only when the file says it was
-- settled AND somebody who can vouch for the receipt is doing the import —
--
--   * the importer is the payee (they say they were paid), or
--   * the payee is a ghost and the payer is the importer or another ghost.
--     A ghost has no account to confirm from, and a ghost's whole ledger is
--     already the importer's word (every ghost expense is) — the row lands
--     exactly where `baaki_record_settlement` + the auto-confirm job would put
--     it, minus the seven-day wait nobody could have used.
--
-- Anything else — the payee is another member on Waves, or the payer is —
-- lands `initiated` with the clock started now, and follows the ordinary path:
-- the payee confirms or disputes, the payer can cancel, and the auto-confirm
-- job settles it after the same window as any other settle-up. That is the
-- same power the payer already had by recording it themselves; the import
-- adds none.
--
-- `at` from the file still dates a confirmed row. A row that lands `initiated`
-- is dated now, on purpose: with the file's date the auto-confirm job would
-- have confirmed a two-year-old "pending" row on its next run, which is the
-- hole this migration closes wearing a different hat.
--
-- The result gains `settlementsPending` so the import screen can tell the
-- user how many are waiting on somebody else.

CREATE OR REPLACE FUNCTION public.baaki_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb DEFAULT '[]'::jsonb, p_origin text DEFAULT 'splitwise'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile_id  uuid := public.baaki_current_profile_id();
  v_author      uuid;
  v_person      jsonb;
  v_expense     jsonb;
  v_settlement  jsonb;
  v_name        text;
  v_member      uuid;
  v_names       jsonb := '{}'::jsonb;   -- name -> member id, as text
  v_payers      jsonb;
  v_shares      jsonb;
  v_entry       record;
  v_created     int := 0;
  v_ghosts      int := 0;
  v_settled     int := 0;
  v_pending     int := 0;
  v_mutation    uuid;
  v_result      jsonb;
  v_from        uuid;
  v_to          uuid;
  v_from_real   boolean;
  v_to_real     boolean;
  v_file_status text;
  v_status      "SettlementStatus";
  v_at          timestamptz;
BEGIN
  IF v_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.profile_id = v_profile_id AND gm.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_author := public.baaki_my_member_id_for(p_group_id, v_profile_id);

  IF jsonb_typeof(p_people) <> 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'NO_PEOPLE: the import named nobody' USING ERRCODE = 'check_violation';
  END IF;

  -- Resolve every name to a member of this group up front, so an unmappable
  -- one fails before a single row is written.
  FOR v_person IN SELECT * FROM jsonb_array_elements(p_people) LOOP
    v_name := btrim(COALESCE(v_person ->> 'name', ''));
    IF v_name = '' THEN
      RAISE EXCEPTION 'NO_PEOPLE: somebody in the file has no name'
        USING ERRCODE = 'check_violation';
    END IF;

    IF (v_person ->> 'memberId') IS NOT NULL THEN
      SELECT gm.id INTO v_member
        FROM public.group_members gm
       WHERE gm.id = (v_person ->> 'memberId')::uuid AND gm.group_id = p_group_id;
      IF v_member IS NULL THEN
        RAISE EXCEPTION 'UNKNOWN_MEMBER: % is not in this group', v_name
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    ELSE
      INSERT INTO public.group_members (group_id, ghost_name, joined_via)
      VALUES (p_group_id, v_name, 'ghost')
      RETURNING id INTO v_member;
      v_ghosts := v_ghosts + 1;
    END IF;

    v_names := v_names || jsonb_build_object(v_name, v_member::text);
  END LOOP;

  FOR v_expense IN SELECT * FROM jsonb_array_elements(p_expenses) LOOP
    -- Names become member ids here rather than on the client, so the client
    -- never gets to choose which member a row lands on.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'memberId', v_names ->> entry.key,
             'amount',   entry.value #>> '{}'
           )), '[]'::jsonb)
      INTO v_payers
      FROM jsonb_each(v_expense -> 'payers') AS entry;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'memberId', v_names ->> entry.key,
             'amount',   entry.value #>> '{}'
           )), '[]'::jsonb)
      INTO v_shares
      FROM jsonb_each(v_expense -> 'shares') AS entry;

    FOR v_entry IN
      SELECT key FROM jsonb_each(v_expense -> 'shares')
      UNION
      SELECT key FROM jsonb_each(v_expense -> 'payers')
    LOOP
      IF (v_names ->> v_entry.key) IS NULL THEN
        RAISE EXCEPTION 'UNKNOWN_MEMBER: "%" appears in an expense but not in the people list',
          v_entry.key USING ERRCODE = 'foreign_key_violation';
      END IF;
    END LOOP;

    v_result := public.baaki_apply_expense(
      p_group_id           => p_group_id,
      p_expense_id         => NULL,
      p_author_member_id   => v_author,
      p_description        => COALESCE(v_expense ->> 'description', 'Imported expense'),
      p_category           => v_expense ->> 'category',
      p_expense_date       => (v_expense ->> 'date')::date,
      p_currency           => upper(COALESCE(v_expense ->> 'currency', 'INR'))::char(3),
      p_amount             => (v_expense ->> 'amount')::bigint,
      -- 'exact' regardless of how the split was originally expressed: the
      -- participants are new members with new ids, so a percentage or a set of
      -- weights would have to be re-divided and could land a paisa somewhere
      -- the file did not. The amounts are the amounts — and with an exact
      -- split the shares ARE the split params, so there is nothing for the
      -- server to recompute; `baaki_check_expense_totals` still refuses a
      -- version whose payers or shares do not sum to the amount.
      p_split_type         => 'exact',
      p_split_params       => jsonb_build_object('kind', 'exact', 'amounts', (
        SELECT COALESCE(jsonb_object_agg(v_names ->> entry.key, entry.value), '{}'::jsonb)
          FROM jsonb_each(v_expense -> 'shares') AS entry
      )),
      p_payers             => v_payers,
      p_shares             => v_shares,
      p_client_mutation_id => (v_expense ->> 'clientMutationId')::uuid,
      p_source             => 'imported'
    );

    -- A replayed row is one this import already wrote — a second tap, or a lost
    -- response. Not an error, and not a second copy either (ADR-005).
    IF COALESCE((v_result ->> 'replayed')::boolean, false) = false THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;

  FOR v_settlement IN SELECT * FROM jsonb_array_elements(p_settlements) LOOP
    IF (v_names ->> (v_settlement ->> 'from')) IS NULL
       OR (v_names ->> (v_settlement ->> 'to')) IS NULL THEN
      RAISE EXCEPTION 'UNKNOWN_MEMBER: a settlement names somebody who is not in the people list'
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    v_from := (v_names ->> (v_settlement ->> 'from'))::uuid;
    v_to   := (v_names ->> (v_settlement ->> 'to'))::uuid;

    v_mutation := (v_settlement ->> 'clientMutationId')::uuid;
    -- Same idempotency rule as the expenses: a replayed import must not pay
    -- somebody twice.
    CONTINUE WHEN v_mutation IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.settlements s WHERE s.client_mutation_id = v_mutation
    );

    -- The file's word on the row, before anybody's consent is considered. A
    -- status the ledger has no name for is refused rather than cast blind.
    v_file_status := lower(COALESCE(v_settlement ->> 'status', 'confirmed'));
    IF v_file_status NOT IN ('confirmed', 'auto_confirmed', 'initiated', 'disputed', 'cancelled') THEN
      RAISE EXCEPTION 'INVALID_STATUS: a settlement cannot be imported as "%"', v_file_status
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT gm.profile_id IS NOT NULL INTO v_from_real
      FROM public.group_members gm WHERE gm.id = v_from;
    SELECT gm.profile_id IS NOT NULL INTO v_to_real
      FROM public.group_members gm WHERE gm.id = v_to;

    IF v_file_status IN ('confirmed', 'auto_confirmed') THEN
      -- Settled, says the file. It stays settled only if the person doing the
      -- import can vouch for the receipt: they are the payee, or the payee is
      -- a ghost and the payer is nobody else on Waves. Otherwise the member it
      -- names gets to confirm it, the way they would any settle-up (ADR-007).
      IF v_to = v_author OR (NOT v_to_real AND (v_from = v_author OR NOT v_from_real)) THEN
        v_status := 'confirmed';
      ELSE
        v_status := 'initiated';
      END IF;
    ELSE
      v_status := v_file_status::"SettlementStatus";
    END IF;

    -- A confirmed row keeps the file's date. A pending one is dated now, so the
    -- auto-confirm window starts when the people on Waves can first see it —
    -- not years ago in the file.
    v_at := CASE
      WHEN v_status = 'initiated' THEN now()
      ELSE COALESCE((v_settlement ->> 'at')::timestamptz, now())
    END;

    INSERT INTO public.settlements
      (group_id, from_member_id, to_member_id, currency, amount, method, status, note,
       initiated_at, confirmed_at, client_mutation_id)
    VALUES (
      p_group_id,
      v_from,
      v_to,
      upper(COALESCE(v_settlement ->> 'currency', 'INR'))::char(3),
      (v_settlement ->> 'amount')::bigint,
      COALESCE(v_settlement ->> 'method', 'other')::"SettlementMethod",
      v_status,
      v_settlement ->> 'note',
      v_at,
      CASE WHEN v_status = 'confirmed' THEN v_at END,
      v_mutation
    );

    IF v_status = 'initiated' THEN
      v_pending := v_pending + 1;
    END IF;
    v_settled := v_settled + 1;
  END LOOP;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    p_group_id, v_author, 'imported', 'group', p_group_id,
    jsonb_build_object(
      'expenses', v_created, 'ghosts', v_ghosts, 'settlements', v_settled,
      'settlementsPending', v_pending, 'from', p_origin
    )
  );

  RETURN jsonb_build_object(
    'groupId', p_group_id,
    'expenses', v_created,
    'ghosts', v_ghosts,
    'settlements', v_settled,
    'settlementsPending', v_pending,
    'members', v_names
  );
END
$$;
