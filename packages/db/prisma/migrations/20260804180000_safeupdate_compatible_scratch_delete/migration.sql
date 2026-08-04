-- Supabase loads the `safeupdate` extension, which refuses any DELETE or
-- UPDATE without a WHERE clause. `baaki_group_pairwise_truth` cleared its
-- transaction-local scratch table with a bare DELETE, which works on stock
-- Postgres (so the local suite passed) but fails on Supabase with
-- "DELETE requires a WHERE clause" — taking every expense write down with it.
--
-- Same function as before, with the scratch cleanup made explicit.

CREATE OR REPLACE FUNCTION public.baaki_group_pairwise_truth(p_group_id uuid)
RETURNS TABLE (from_member_id uuid, to_member_id uuid, currency char(3), amount bigint)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_version   RECORD;
  v_debtor_ids   uuid[];
  v_debtor_amts  bigint[];
  v_credit_ids   uuid[];
  v_credit_amts  bigint[];
  d int; c int;
  v_take bigint;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS baaki_pairwise_scratch (
    a uuid, b uuid, cur char(3), amt bigint
  ) ON COMMIT DROP;
  DELETE FROM baaki_pairwise_scratch WHERE true;

  FOR v_version IN
    SELECT ev.id, ev.currency
    FROM public.expense_versions ev
    JOIN public.expenses e
      ON e.id = ev.expense_id
     AND e.current_version_id = ev.id
     AND e.deleted_at IS NULL
    WHERE e.group_id = p_group_id
  LOOP
    SELECT array_agg(member_id ORDER BY member_id), array_agg(-net ORDER BY member_id)
      INTO v_debtor_ids, v_debtor_amts
    FROM (
      SELECT member_id, SUM(delta)::bigint AS net
      FROM (
        SELECT member_id, amount AS delta FROM public.expense_payers
         WHERE expense_version_id = v_version.id
        UNION ALL
        SELECT member_id, -amount FROM public.expense_shares
         WHERE expense_version_id = v_version.id
      ) m GROUP BY member_id HAVING SUM(delta) < 0
    ) debtors;

    SELECT array_agg(member_id ORDER BY member_id), array_agg(net ORDER BY member_id)
      INTO v_credit_ids, v_credit_amts
    FROM (
      SELECT member_id, SUM(delta)::bigint AS net
      FROM (
        SELECT member_id, amount AS delta FROM public.expense_payers
         WHERE expense_version_id = v_version.id
        UNION ALL
        SELECT member_id, -amount FROM public.expense_shares
         WHERE expense_version_id = v_version.id
      ) m GROUP BY member_id HAVING SUM(delta) > 0
    ) creditors;

    IF v_debtor_ids IS NULL OR v_credit_ids IS NULL THEN
      CONTINUE;
    END IF;

    d := 1; c := 1;
    WHILE d <= array_length(v_debtor_ids, 1) AND c <= array_length(v_credit_ids, 1) LOOP
      v_take := LEAST(v_debtor_amts[d], v_credit_amts[c]);
      IF v_take > 0 THEN
        INSERT INTO baaki_pairwise_scratch
        VALUES (v_debtor_ids[d], v_credit_ids[c], v_version.currency, v_take);
        v_debtor_amts[d] := v_debtor_amts[d] - v_take;
        v_credit_amts[c] := v_credit_amts[c] - v_take;
      END IF;
      IF v_debtor_amts[d] = 0 THEN d := d + 1; END IF;
      IF v_credit_amts[c] = 0 THEN c := c + 1; END IF;
    END LOOP;
  END LOOP;

  -- Settlements pay debt down: `from` paying `to` cancels what `from` owes `to`.
  INSERT INTO baaki_pairwise_scratch
  SELECT st.to_member_id, st.from_member_id, st.currency, -st.amount
  FROM public.settlements st
  WHERE st.group_id = p_group_id AND st.status IN ('confirmed', 'auto_confirmed');

  RETURN QUERY
  WITH canonical AS (
    SELECT
      LEAST(a, b) AS lo,
      GREATEST(a, b) AS hi,
      cur,
      SUM(CASE WHEN a < b THEN amt ELSE -amt END)::bigint AS net
    FROM baaki_pairwise_scratch
    GROUP BY 1, 2, 3
  )
  SELECT
    CASE WHEN net > 0 THEN lo ELSE hi END,
    CASE WHEN net > 0 THEN hi ELSE lo END,
    cur,
    abs(net)::bigint
  FROM canonical
  WHERE net <> 0;
END
$$;
