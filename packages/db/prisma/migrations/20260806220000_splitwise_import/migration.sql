-- Splitwise import (ADR-012, TDR §10) — the switching on-ramp.
--
-- The parser lives in `packages/core` and has since M0; what was missing was
-- the write. TDR §10 asks for a *transactional* insert, and that word is the
-- whole design: somebody moving four years of history has no way to tell a
-- half-finished import from a complete one, because the balances still add up
-- either way — they are just the balances of a different, smaller group.
--
-- So this is one function. A function body is one transaction: either every
-- ghost and every expense lands, or the database is exactly as it was. The
-- edge function TDR §10 names would have looped over REST calls and had no
-- such property, which is why the import lives here instead. (Deviation
-- recorded rather than hidden; the TDR wants amending.)
--
-- Rows are tagged so they can be told apart later. Who paid, in a Splitwise
-- export, is a *reconstruction* — the file carries each person's net for a row,
-- not the (paid, owed) pair that produced it, and many pairs produce the same
-- net. Balances are exact; the payer attribution is a deterministic guess, and
-- an expense that says `imported` is one nobody should be surprised to find
-- they apparently paid for.

-- ───────────────────────────────────────────── 1. where a row came from ──

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ExpenseSource') THEN
    CREATE TYPE "ExpenseSource" AS ENUM ('manual', 'imported');
  END IF;
END
$$;

ALTER TABLE public.expense_versions
  ADD COLUMN IF NOT EXISTS source "ExpenseSource" NOT NULL DEFAULT 'manual';


-- ────────────────────────────────────── 2. carrying it through the write ──
-- NOTE — the overload trap, for the fourth time: CREATE OR REPLACE with a
-- different argument count creates a SECOND function rather than replacing the
-- first, and every existing call then fails as ambiguous. Drop the old
-- signature explicitly.

DROP FUNCTION IF EXISTS public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid, int, jsonb
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
  p_source             text DEFAULT 'manual'
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
     currency, amount, split_type, split_params, receipt_id, notes, client_mutation_id, fx,
     source)
  VALUES
    (p_expense_id, v_version_no, p_author_member_id, p_description, p_category, p_expense_date,
     upper(p_currency), p_amount, p_split_type::"SplitType", p_split_params, p_receipt_id,
     p_notes, p_client_mutation_id, p_fx, COALESCE(p_source, 'manual')::"ExpenseSource")
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

GRANT EXECUTE ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char(3), bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid,
  int, jsonb, text
) TO authenticated, anon;


-- ─────────────────────────────────────────────── 3. the import itself ──

CREATE OR REPLACE FUNCTION public.baaki_import_splitwise(
  p_group_id uuid,
  -- [{ "name": "Asha", "memberId": "<uuid>" | null }] — one entry per column in
  -- the file. A null memberId means "this person is new here": create a ghost.
  p_people   jsonb,
  -- [{ "clientMutationId", "description", "category", "date", "currency",
  --    "amount", "payers": { "Asha": "120000" }, "shares": { ... } }]
  -- Amounts are minor units as strings. A number in jsonb is a double, and a
  -- double is how a paisa goes missing from a four-year history (ADR-003).
  p_expenses jsonb
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
  v_name        text;
  v_member      uuid;
  v_names       jsonb := '{}'::jsonb;   -- name -> member id, as text
  v_payers      jsonb;
  v_shares      jsonb;
  v_entry       record;
  v_created     int := 0;
  v_ghosts      int := 0;
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

  -- Resolve every column in the file to a member of this group, creating the
  -- ghosts as we go. Done up front so an unmappable name fails before a single
  -- expense is written.
  FOR v_person IN SELECT * FROM jsonb_array_elements(p_people) LOOP
    v_name := btrim(COALESCE(v_person ->> 'name', ''));
    IF v_name = '' THEN
      RAISE EXCEPTION 'NO_PEOPLE: a column in the file has no name'
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
      -- A ghost is a real participant who has not joined yet (ADR-006). They
      -- can claim this history later, and it will already be theirs.
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

    -- A name in a row that was not a column in the header would resolve to
    -- NULL and be rejected downstream as an unknown member; say so in the
    -- file's own vocabulary instead.
    FOR v_entry IN SELECT key FROM jsonb_each(v_expense -> 'shares') LOOP
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
      p_split_type         => 'exact',
      p_split_params       => jsonb_build_object('kind', 'exact', 'amounts', v_expense -> 'shares'),
      p_payers             => v_payers,
      p_shares             => v_shares,
      p_client_mutation_id => (v_expense ->> 'clientMutationId')::uuid,
      p_source             => 'imported'
    );

    -- A replayed row is one this import already wrote — the person tapped
    -- Import twice, or the response was lost. Not an error, and not a second
    -- copy either; it simply does not count as new.
    IF COALESCE((v_result ->> 'replayed')::boolean, false) = false THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    p_group_id, v_author, 'imported', 'group', p_group_id,
    jsonb_build_object('expenses', v_created, 'ghosts', v_ghosts, 'from', 'splitwise')
  );

  RETURN jsonb_build_object(
    'groupId', p_group_id,
    'expenses', v_created,
    'ghosts', v_ghosts,
    'members', v_names
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_import_splitwise(uuid, jsonb, jsonb) TO authenticated, anon;
