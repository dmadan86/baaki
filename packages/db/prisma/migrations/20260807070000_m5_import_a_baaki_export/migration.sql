-- Reading a Baaki export back in (M5, ADR-012).
--
-- The M5 acceptance line is "export re-imports losslessly", and the word doing
-- the work is *losslessly*: the balances that come out of the new group must be
-- the balances that went into the file, to the paisa, for every person and
-- every currency.
--
-- That rules out routing this through `baaki_import_splitwise`. A Splitwise
-- file carries each person's net and the payer is reconstructed; a Baaki export
-- carries the real (paid, owed) pair, and throwing it away on the way back in
-- would be a strange thing for an app to do to its own file. It also carries
-- settlements, which that function has no notion of and which move every
-- balance they touch.
--
-- So: one function, one transaction, the same shape of arguments, plus
-- settlements. `baaki_import_splitwise` becomes a thin call into it, so there
-- is one import path to reason about rather than two that drift.
--
-- What is deliberately NOT carried across:
--
--   * **Old ids.** Every expense, member and settlement is new here. Importing
--     ids would let a file overwrite rows in a group it was never part of.
--   * **Version history.** The export holds every version of every expense
--     (ADR-004); what is re-imported is what each expense currently says. The
--     old history describes edits made by people who are not members of this
--     new group, and re-attributing them would be a fiction. Balances are
--     computed from current versions only, so nothing is lost that the
--     acceptance criterion measures.
--   * **Settlement allocations.** They name expense ids, and those ids are new.
--     Allocations decide which expenses a payment is applied against, never how
--     much anybody owes in total, so the balances are unaffected — the payment
--     lands as an unallocated settlement, oldest-first, exactly as one recorded
--     by hand would.
--
-- All of that is what "lossless" honestly means here, and the import screen
-- says the same thing in words before anybody taps it.

-- ─────────────────────────────────────────────── 1. the general import ──

CREATE OR REPLACE FUNCTION public.baaki_import_ledger(
  p_group_id uuid,
  -- [{ "name": "Asha", "memberId": "<uuid>" | null }] — null means "new here":
  -- create a ghost they can claim later (ADR-006).
  p_people   jsonb,
  -- [{ "clientMutationId", "description", "category", "date", "currency",
  --    "amount", "payers": { "Asha": "120000" }, "shares": { ... } }]
  -- Minor units as strings: a number in jsonb is a double, and a double is how
  -- a paisa goes missing from four years of history (ADR-003).
  p_expenses jsonb,
  -- [{ "clientMutationId", "from": "Asha", "to": "Ravi", "currency", "amount",
  --    "method", "status", "note", "at" }] — only confirmed and auto_confirmed
  -- settlements move a balance, but the rest are carried so the history reads
  -- the way it did in the file.
  p_settlements jsonb DEFAULT '[]'::jsonb,
  /** Recorded in the activity entry, so the feed can say where this came from. */
  p_origin   text DEFAULT 'splitwise'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  v_mutation    uuid;
  v_result      jsonb;
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
      -- the file did not. The amounts are the amounts.
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

    v_mutation := (v_settlement ->> 'clientMutationId')::uuid;
    -- Same idempotency rule as the expenses: a replayed import must not pay
    -- somebody twice.
    CONTINUE WHEN v_mutation IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.settlements s WHERE s.client_mutation_id = v_mutation
    );

    INSERT INTO public.settlements
      (group_id, from_member_id, to_member_id, currency, amount, method, status, note,
       initiated_at, confirmed_at, client_mutation_id)
    VALUES (
      p_group_id,
      (v_names ->> (v_settlement ->> 'from'))::uuid,
      (v_names ->> (v_settlement ->> 'to'))::uuid,
      upper(COALESCE(v_settlement ->> 'currency', 'INR'))::char(3),
      (v_settlement ->> 'amount')::bigint,
      COALESCE(v_settlement ->> 'method', 'other')::"SettlementMethod",
      COALESCE(v_settlement ->> 'status', 'confirmed')::"SettlementStatus",
      v_settlement ->> 'note',
      COALESCE((v_settlement ->> 'at')::timestamptz, now()),
      CASE
        WHEN COALESCE(v_settlement ->> 'status', 'confirmed') IN ('confirmed', 'auto_confirmed')
        THEN COALESCE((v_settlement ->> 'at')::timestamptz, now())
      END,
      v_mutation
    );
    v_settled := v_settled + 1;
  END LOOP;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    p_group_id, v_author, 'imported', 'group', p_group_id,
    jsonb_build_object(
      'expenses', v_created, 'ghosts', v_ghosts, 'settlements', v_settled, 'from', p_origin
    )
  );

  RETURN jsonb_build_object(
    'groupId', p_group_id,
    'expenses', v_created,
    'ghosts', v_ghosts,
    'settlements', v_settled,
    'members', v_names
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_import_ledger(uuid, jsonb, jsonb, jsonb, text)
  TO authenticated, anon;


-- ──────────────────────────────── 2. the Splitwise path, now a wrapper ──
-- Same signature it has always had, so nothing that calls it changes.

CREATE OR REPLACE FUNCTION public.baaki_import_splitwise(
  p_group_id uuid,
  p_people   jsonb,
  p_expenses jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.baaki_import_ledger(p_group_id, p_people, p_expenses, '[]'::jsonb, 'splitwise');
$$;

GRANT EXECUTE ON FUNCTION public.baaki_import_splitwise(uuid, jsonb, jsonb) TO authenticated, anon;
