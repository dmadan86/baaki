-- ============================================================================
-- Baaki — everything Prisma cannot express (TDR §2.0).
--
--   1. identity helpers (works on Supabase AND on a bare Postgres in CI)
--   2. structural CHECK constraints
--   3. append-only guards            (ADR-004)
--   4. money invariants              (ADR-003 / ADR-004)
--   5. settlement state machine      (ADR-007)
--   6. per-group sync sequence       (ADR-005 / TDR §4)
--   7. derived balances + pairwise   (ADR-004 / ADR-009)
--   8. row-level security            (ADR-013)
--
-- Reviewed like code. Every new table must arrive with its policies or CI fails.
-- ============================================================================

-- ─────────────────────────────────────────────────────── 0. roles ──
-- Supabase already has these; created here so the same migration runs against
-- a plain Postgres in CI and in local RLS tests.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;

-- ──────────────────────────────────────────── 1. identity helpers ──

-- The caller's profile id, taken from the JWT. Mirrors Supabase's auth.uid()
-- without touching the auth schema, so the policies are testable anywhere.
CREATE OR REPLACE FUNCTION public.baaki_current_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    COALESCE(
      current_setting('request.jwt.claim.sub', true),
      (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

-- Guest (anonymous) sessions carry the groups they were invited to as a claim
-- minted by the invite-mint edge function (ADR-006 / ADR-013). Write access for
-- those sessions is scoped strictly to those groups.
CREATE OR REPLACE FUNCTION public.baaki_scoped_group_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT jsonb_array_elements_text(
        COALESCE(
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb
            #> '{app_metadata,baaki_groups}',
          '[]'::jsonb
        )
      )::uuid
    ),
    ARRAY[]::uuid[]
  )
$$;

-- The single predicate every policy reduces to (TDR §2 RLS sketch).
CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    p_group_id = ANY (public.baaki_scoped_group_ids())
    OR EXISTS (
      SELECT 1
      FROM public.group_members gm
      WHERE gm.group_id = p_group_id
        AND gm.profile_id = public.baaki_current_profile_id()
        AND gm.left_at IS NULL
    )
$$;

CREATE OR REPLACE FUNCTION public.is_group_admin(p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.profile_id = public.baaki_current_profile_id()
      AND gm.left_at IS NULL
      AND gm.role = 'admin'
  )
$$;

-- Group a member row belongs to, for policies on child tables.
CREATE OR REPLACE FUNCTION public.baaki_member_group_id(p_member_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT group_id FROM public.group_members WHERE id = p_member_id
$$;

CREATE OR REPLACE FUNCTION public.baaki_version_group_id(p_version_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.group_id
  FROM public.expense_versions ev
  JOIN public.expenses e ON e.id = ev.expense_id
  WHERE ev.id = p_version_id
$$;

-- ─────────────────────────────────────── 2. structural constraints ──

-- ADR-006: a member is either a real profile or a ghost, never both, never neither.
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_profile_xor_ghost
  CHECK ((profile_id IS NULL) <> (ghost_name IS NULL));

ALTER TABLE public.expense_versions
  ADD CONSTRAINT expense_versions_amount_non_negative CHECK (amount >= 0),
  ADD CONSTRAINT expense_versions_currency_upper CHECK (currency = upper(currency)),
  ADD CONSTRAINT expense_versions_version_no_positive CHECK (version_no >= 1);

ALTER TABLE public.expense_payers
  ADD CONSTRAINT expense_payers_amount_non_negative CHECK (amount >= 0);

ALTER TABLE public.settlements
  ADD CONSTRAINT settlements_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT settlements_distinct_members CHECK (from_member_id <> to_member_id),
  ADD CONSTRAINT settlements_currency_upper CHECK (currency = upper(currency));

ALTER TABLE public.settlement_allocations
  ADD CONSTRAINT settlement_allocations_amount_positive CHECK (amount > 0);

ALTER TABLE public.reminders
  ADD CONSTRAINT reminders_distinct_members CHECK (from_member_id <> to_member_id);

ALTER TABLE public.groups
  ADD CONSTRAINT groups_currency_upper CHECK (default_currency = upper(default_currency));

-- ─────────────────────────────────────────── 3. append-only guards ──
-- ADR-004: expense history is immutable. Edits insert a new version; deletes
-- are soft. Nothing here can be rewritten, by anyone, including us.

CREATE OR REPLACE FUNCTION public.baaki_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'APPEND_ONLY: % rows cannot be % (ADR-004). Insert a new version or set deleted_at.',
    TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER expense_versions_append_only
  BEFORE UPDATE OR DELETE ON public.expense_versions
  FOR EACH ROW EXECUTE FUNCTION public.baaki_forbid_mutation();

CREATE TRIGGER expense_payers_append_only
  BEFORE UPDATE ON public.expense_payers
  FOR EACH ROW EXECUTE FUNCTION public.baaki_forbid_mutation();

CREATE TRIGGER expense_shares_append_only
  BEFORE UPDATE ON public.expense_shares
  FOR EACH ROW EXECUTE FUNCTION public.baaki_forbid_mutation();

CREATE TRIGGER expenses_no_hard_delete
  BEFORE DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.baaki_forbid_mutation();

CREATE TRIGGER settlements_no_hard_delete
  BEFORE DELETE ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION public.baaki_forbid_mutation();

CREATE TRIGGER activity_log_append_only
  BEFORE UPDATE OR DELETE ON public.activity_log
  FOR EACH ROW EXECUTE FUNCTION public.baaki_forbid_mutation();

-- ADR-004: soft deletes stay restorable for 30 days, then the restore path
-- closes (the row and its history remain — this only gates un-deleting).
CREATE OR REPLACE FUNCTION public.baaki_expense_restore_window()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL
     AND NEW.deleted_at IS NULL
     AND OLD.deleted_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'RESTORE_WINDOW_EXPIRED: this expense was deleted more than 30 days ago'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER expenses_restore_window
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.baaki_expense_restore_window();

-- ────────────────────────────────────────────── 4. money invariants ──
-- ADR-003/004: Σ payers = Σ shares = amount, checked at COMMIT so a version and
-- its rows can be written incrementally inside one transaction.

CREATE OR REPLACE FUNCTION public.baaki_check_expense_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_version_id uuid;
  v_amount     bigint;
  v_payers     bigint;
  v_shares     bigint;
BEGIN
  -- NEW/OLD only exist for the right operations, and only the child tables
  -- carry expense_version_id, so resolve the version id explicitly.
  IF TG_TABLE_NAME = 'expense_versions' THEN
    v_version_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_version_id := OLD.expense_version_id;
  ELSE
    v_version_id := NEW.expense_version_id;
  END IF;

  SELECT amount INTO v_amount FROM public.expense_versions WHERE id = v_version_id;
  IF v_amount IS NULL THEN
    RETURN NULL; -- version was removed in the same transaction
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_payers
    FROM public.expense_payers WHERE expense_version_id = v_version_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_shares
    FROM public.expense_shares WHERE expense_version_id = v_version_id;

  IF v_payers <> v_amount THEN
    RAISE EXCEPTION
      'PAYER_MISMATCH: payers sum to % but the expense is % (version %)',
      v_payers, v_amount, v_version_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_shares <> v_amount THEN
    RAISE EXCEPTION
      'SHARE_MISMATCH: shares sum to % but the expense is % (version %)',
      v_shares, v_amount, v_version_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER expense_versions_totals_match
  AFTER INSERT ON public.expense_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.baaki_check_expense_totals();

CREATE CONSTRAINT TRIGGER expense_payers_totals_match
  AFTER INSERT OR DELETE ON public.expense_payers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.baaki_check_expense_totals();

CREATE CONSTRAINT TRIGGER expense_shares_totals_match
  AFTER INSERT OR DELETE ON public.expense_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.baaki_check_expense_totals();

-- Allocations may never exceed the settlement they belong to (ADR-007).
CREATE OR REPLACE FUNCTION public.baaki_check_settlement_allocations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_settlement_id uuid;
  v_amount        bigint;
  v_allocated     bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_settlement_id := OLD.settlement_id;
  ELSE
    v_settlement_id := NEW.settlement_id;
  END IF;
  SELECT amount INTO v_amount FROM public.settlements WHERE id = v_settlement_id;
  IF v_amount IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_allocated
    FROM public.settlement_allocations WHERE settlement_id = v_settlement_id;

  IF v_allocated > v_amount THEN
    RAISE EXCEPTION
      'ALLOCATION_EXCEEDS_SETTLEMENT: allocated % of a % settlement', v_allocated, v_amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER settlement_allocations_within_settlement
  AFTER INSERT OR UPDATE OR DELETE ON public.settlement_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.baaki_check_settlement_allocations();

-- ──────────────────────────────────── 5. settlement state machine ──
-- Mirrors packages/core `canTransition` (ADR-007). Two implementations, one
-- truth: the RLS tests and the core property tests both assert this table.

CREATE OR REPLACE FUNCTION public.baaki_settlement_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'initiated'  AND NEW.status IN ('confirmed', 'auto_confirmed', 'disputed', 'cancelled'))
    OR (OLD.status = 'auto_confirmed' AND NEW.status = 'disputed')
    OR (OLD.status = 'disputed' AND NEW.status IN ('confirmed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: settlement cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('confirmed', 'auto_confirmed') AND NEW.confirmed_at IS NULL THEN
    NEW.confirmed_at := now();
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER settlements_transition_guard
  BEFORE UPDATE ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION public.baaki_settlement_transition();

-- ADR-010: nudges are limited to one per pair per day, enforced in SQL so no
-- client bug can turn Baaki into a collections agency.
CREATE OR REPLACE FUNCTION public.baaki_nudge_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.last_nudged_at IS NOT NULL
     AND OLD.last_nudged_at IS NOT NULL
     AND NEW.last_nudged_at <> OLD.last_nudged_at
     AND NEW.last_nudged_at < OLD.last_nudged_at + interval '1 day' THEN
    RAISE EXCEPTION 'NUDGE_RATE_LIMIT: only one nudge per pair per day'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER reminders_nudge_rate_limit
  BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.baaki_nudge_rate_limit();

-- ───────────────────────────────────────── 6. per-group sync cursor ──
-- TDR §4: clients pull "everything since seq N" for a group.

CREATE OR REPLACE FUNCTION public.baaki_next_group_seq(p_group_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.groups
     SET updated_seq = updated_seq + 1
   WHERE id = p_group_id
  RETURNING updated_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_stamp_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_seq := public.baaki_next_group_seq(NEW.group_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER group_members_stamp_seq
  BEFORE INSERT OR UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

CREATE TRIGGER expenses_stamp_seq
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

CREATE TRIGGER settlements_stamp_seq
  BEFORE INSERT OR UPDATE ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

CREATE TRIGGER activity_log_stamp_seq
  BEFORE INSERT ON public.activity_log
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

-- ─────────────────────────────────── 7. derived balances (ADR-004) ──
-- Balances are NEVER a stored running total. `*_truth` are the ground-truth
-- aggregates; the trigger-maintained tables must always equal them, which CI
-- asserts on every push.

CREATE OR REPLACE FUNCTION public.baaki_group_balances_truth(p_group_id uuid)
RETURNS TABLE (member_id uuid, currency char(3), balance bigint)
LANGUAGE sql
STABLE
AS $$
  WITH live_versions AS (
    SELECT ev.id, ev.currency
    FROM public.expense_versions ev
    JOIN public.expenses e
      ON e.id = ev.expense_id
     AND e.current_version_id = ev.id
     AND e.deleted_at IS NULL
    WHERE e.group_id = p_group_id
  ),
  movements AS (
    SELECT p.member_id, lv.currency, p.amount AS delta
      FROM public.expense_payers p JOIN live_versions lv ON lv.id = p.expense_version_id
    UNION ALL
    SELECT s.member_id, lv.currency, -s.amount
      FROM public.expense_shares s JOIN live_versions lv ON lv.id = s.expense_version_id
    UNION ALL
    SELECT st.from_member_id, st.currency, st.amount
      FROM public.settlements st
     WHERE st.group_id = p_group_id AND st.status IN ('confirmed', 'auto_confirmed')
    UNION ALL
    SELECT st.to_member_id, st.currency, -st.amount
      FROM public.settlements st
     WHERE st.group_id = p_group_id AND st.status IN ('confirmed', 'auto_confirmed')
  )
  SELECT member_id, currency, SUM(delta)::bigint AS balance
  FROM movements
  GROUP BY member_id, currency
  HAVING SUM(delta) <> 0
$$;

-- Pairwise "who owes whom", expense by expense. Matches
-- packages/core `computePairwiseBalances`: debtors and creditors of each
-- expense are matched in stable member-id order, so both implementations
-- produce identical edges.
CREATE OR REPLACE FUNCTION public.baaki_group_pairwise_truth(p_group_id uuid)
RETURNS TABLE (from_member_id uuid, to_member_id uuid, currency char(3), amount bigint)
LANGUAGE plpgsql
-- VOLATILE (the default): it materialises the per-expense matching into a
-- transaction-local scratch table, which a STABLE function may not do.
AS $$
-- The RETURNS TABLE columns are OUT parameters, and `amount` / `currency` also
-- name real columns in the queries below; tell plpgsql the column always wins.
-- Every local here is v_-prefixed, so nothing else is affected.
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
  DELETE FROM baaki_pairwise_scratch;

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

-- Refresh the materialised copies inside the writing transaction, so a reader
-- can never observe a balance that disagrees with the ledger.
CREATE OR REPLACE FUNCTION public.baaki_refresh_group_balances(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.group_balances WHERE group_id = p_group_id;
  INSERT INTO public.group_balances (group_id, member_id, currency, balance, updated_at)
  SELECT p_group_id, t.member_id, t.currency, t.balance, now()
  FROM public.baaki_group_balances_truth(p_group_id) t;

  DELETE FROM public.pairwise_balances WHERE group_id = p_group_id;
  INSERT INTO public.pairwise_balances
    (group_id, from_member_id, to_member_id, currency, amount, updated_at)
  SELECT p_group_id, t.from_member_id, t.to_member_id, t.currency, t.amount, now()
  FROM public.baaki_group_pairwise_truth(p_group_id) t;
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_touch_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  IF TG_TABLE_NAME IN ('expenses', 'settlements') THEN
    IF TG_OP = 'DELETE' THEN
      v_group_id := OLD.group_id;
    ELSE
      v_group_id := NEW.group_id;
    END IF;
  ELSIF TG_TABLE_NAME IN ('expense_payers', 'expense_shares') THEN
    IF TG_OP = 'DELETE' THEN
      v_group_id := public.baaki_version_group_id(OLD.expense_version_id);
    ELSE
      v_group_id := public.baaki_version_group_id(NEW.expense_version_id);
    END IF;
  END IF;

  IF v_group_id IS NOT NULL THEN
    PERFORM public.baaki_refresh_group_balances(v_group_id);
  END IF;
  RETURN NULL;
END
$$;

-- Deferred so the refresh runs once the whole expense (version + payers +
-- shares) is in place and consistent.
CREATE CONSTRAINT TRIGGER expenses_refresh_balances
  AFTER INSERT OR UPDATE ON public.expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.baaki_touch_balances();

CREATE CONSTRAINT TRIGGER expense_shares_refresh_balances
  AFTER INSERT OR DELETE ON public.expense_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.baaki_touch_balances();

CREATE CONSTRAINT TRIGGER expense_payers_refresh_balances
  AFTER INSERT OR DELETE ON public.expense_payers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.baaki_touch_balances();

CREATE CONSTRAINT TRIGGER settlements_refresh_balances
  AFTER INSERT OR UPDATE ON public.settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.baaki_touch_balances();

-- ────────────────────────────────────────────────────── 8. RLS ──
-- ADR-013: the client is assumed hostile. Every table is membership-scoped;
-- anything that crosses a privilege boundary has no policy at all and is
-- reachable only by the service role inside an edge function.

ALTER TABLE public.profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_versions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_payers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_shares         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_item_claims    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlements            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_tokens            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_balances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pairwise_balances      ENABLE ROW LEVEL SECURITY;

-- profiles: yourself only. No directory, no contact scraping (ADR-013).
CREATE POLICY profiles_select_self ON public.profiles
  FOR SELECT TO authenticated, anon
  USING (id = public.baaki_current_profile_id());
CREATE POLICY profiles_insert_self ON public.profiles
  FOR INSERT TO authenticated, anon
  WITH CHECK (id = public.baaki_current_profile_id());
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE TO authenticated, anon
  USING (id = public.baaki_current_profile_id())
  WITH CHECK (id = public.baaki_current_profile_id());

-- Members of a group can see each other's display names and VPAs — that is
-- exactly the data a split needs, and nothing more.
CREATE POLICY profiles_select_co_members ON public.profiles
  FOR SELECT TO authenticated, anon
  USING (EXISTS (
    SELECT 1
    FROM public.group_members mine
    JOIN public.group_members theirs ON theirs.group_id = mine.group_id
    WHERE mine.profile_id = public.baaki_current_profile_id()
      AND mine.left_at IS NULL
      AND theirs.profile_id = public.profiles.id
  ));

CREATE POLICY groups_select ON public.groups
  FOR SELECT TO authenticated, anon USING (public.is_group_member(id));
CREATE POLICY groups_insert ON public.groups
  FOR INSERT TO authenticated
  WITH CHECK (created_by = public.baaki_current_profile_id());
CREATE POLICY groups_update ON public.groups
  FOR UPDATE TO authenticated, anon
  USING (public.is_group_member(id)) WITH CHECK (public.is_group_member(id));

CREATE POLICY group_members_select ON public.group_members
  FOR SELECT TO authenticated, anon USING (public.is_group_member(group_id));
-- Members may add ghosts (profile_id IS NULL). Attaching a real profile to a
-- ghost is the claim/merge flow and runs service-role-only (ADR-006).
CREATE POLICY group_members_insert_ghost ON public.group_members
  FOR INSERT TO authenticated, anon
  WITH CHECK (public.is_group_member(group_id) AND profile_id IS NULL);
CREATE POLICY group_members_update ON public.group_members
  FOR UPDATE TO authenticated, anon
  USING (public.is_group_member(group_id) AND profile_id IS NULL)
  WITH CHECK (public.is_group_member(group_id) AND profile_id IS NULL);
CREATE POLICY group_members_update_self ON public.group_members
  FOR UPDATE TO authenticated
  USING (profile_id = public.baaki_current_profile_id())
  WITH CHECK (profile_id = public.baaki_current_profile_id());

-- invites: members can mint, nobody can read. The token is verified against the
-- hash inside an edge function (TDR §2).
CREATE POLICY invites_insert ON public.invites
  FOR INSERT TO authenticated WITH CHECK (public.is_group_member(group_id));
CREATE POLICY invites_revoke ON public.invites
  FOR UPDATE TO authenticated
  USING (public.is_group_admin(group_id)) WITH CHECK (public.is_group_admin(group_id));

CREATE POLICY expenses_select ON public.expenses
  FOR SELECT TO authenticated, anon USING (public.is_group_member(group_id));
CREATE POLICY expenses_insert ON public.expenses
  FOR INSERT TO authenticated, anon WITH CHECK (public.is_group_member(group_id));
CREATE POLICY expenses_update ON public.expenses
  FOR UPDATE TO authenticated, anon
  USING (public.is_group_member(group_id)) WITH CHECK (public.is_group_member(group_id));

CREATE POLICY expense_versions_select ON public.expense_versions
  FOR SELECT TO authenticated, anon
  USING (public.is_group_member(public.baaki_version_group_id(id)));
CREATE POLICY expense_versions_insert ON public.expense_versions
  FOR INSERT TO authenticated, anon
  WITH CHECK (public.is_group_member(
    (SELECT group_id FROM public.expenses WHERE id = expense_id)
  ));

CREATE POLICY expense_payers_select ON public.expense_payers
  FOR SELECT TO authenticated, anon
  USING (public.is_group_member(public.baaki_version_group_id(expense_version_id)));
CREATE POLICY expense_payers_insert ON public.expense_payers
  FOR INSERT TO authenticated, anon
  WITH CHECK (public.is_group_member(public.baaki_version_group_id(expense_version_id)));

CREATE POLICY expense_shares_select ON public.expense_shares
  FOR SELECT TO authenticated, anon
  USING (public.is_group_member(public.baaki_version_group_id(expense_version_id)));
CREATE POLICY expense_shares_insert ON public.expense_shares
  FOR INSERT TO authenticated, anon
  WITH CHECK (public.is_group_member(public.baaki_version_group_id(expense_version_id)));

CREATE POLICY receipts_select ON public.receipts
  FOR SELECT TO authenticated, anon USING (public.is_group_member(group_id));
CREATE POLICY receipts_insert ON public.receipts
  FOR INSERT TO authenticated, anon WITH CHECK (public.is_group_member(group_id));
CREATE POLICY receipts_update ON public.receipts
  FOR UPDATE TO authenticated, anon
  USING (public.is_group_member(group_id)) WITH CHECK (public.is_group_member(group_id));

CREATE POLICY receipt_item_claims_select ON public.receipt_item_claims
  FOR SELECT TO authenticated, anon
  USING (public.is_group_member(
    (SELECT group_id FROM public.receipts WHERE id = receipt_id)
  ));
CREATE POLICY receipt_item_claims_insert ON public.receipt_item_claims
  FOR INSERT TO authenticated, anon
  WITH CHECK (public.is_group_member(
    (SELECT group_id FROM public.receipts WHERE id = receipt_id)
  ));
CREATE POLICY receipt_item_claims_delete ON public.receipt_item_claims
  FOR DELETE TO authenticated, anon
  USING (public.is_group_member(
    (SELECT group_id FROM public.receipts WHERE id = receipt_id)
  ));

CREATE POLICY settlements_select ON public.settlements
  FOR SELECT TO authenticated, anon USING (public.is_group_member(group_id));
CREATE POLICY settlements_insert ON public.settlements
  FOR INSERT TO authenticated, anon WITH CHECK (public.is_group_member(group_id));
CREATE POLICY settlements_update ON public.settlements
  FOR UPDATE TO authenticated, anon
  USING (public.is_group_member(group_id)) WITH CHECK (public.is_group_member(group_id));

CREATE POLICY settlement_allocations_select ON public.settlement_allocations
  FOR SELECT TO authenticated, anon
  USING (public.is_group_member(
    (SELECT group_id FROM public.settlements WHERE id = settlement_id)
  ));
CREATE POLICY settlement_allocations_insert ON public.settlement_allocations
  FOR INSERT TO authenticated, anon
  WITH CHECK (public.is_group_member(
    (SELECT group_id FROM public.settlements WHERE id = settlement_id)
  ));

CREATE POLICY activity_log_select ON public.activity_log
  FOR SELECT TO authenticated, anon USING (public.is_group_member(group_id));
CREATE POLICY activity_log_insert ON public.activity_log
  FOR INSERT TO authenticated, anon WITH CHECK (public.is_group_member(group_id));

CREATE POLICY reminders_select ON public.reminders
  FOR SELECT TO authenticated, anon USING (public.is_group_member(group_id));
CREATE POLICY reminders_insert ON public.reminders
  FOR INSERT TO authenticated, anon WITH CHECK (public.is_group_member(group_id));
CREATE POLICY reminders_update ON public.reminders
  FOR UPDATE TO authenticated, anon
  USING (public.is_group_member(group_id)) WITH CHECK (public.is_group_member(group_id));

CREATE POLICY push_tokens_own ON public.push_tokens
  FOR ALL TO authenticated
  USING (profile_id = public.baaki_current_profile_id())
  WITH CHECK (profile_id = public.baaki_current_profile_id());

CREATE POLICY notifications_select_own ON public.notifications
  FOR SELECT TO authenticated USING (profile_id = public.baaki_current_profile_id());
CREATE POLICY notifications_update_own ON public.notifications
  FOR UPDATE TO authenticated
  USING (profile_id = public.baaki_current_profile_id())
  WITH CHECK (profile_id = public.baaki_current_profile_id());

CREATE POLICY email_events_select_own ON public.email_events
  FOR SELECT TO authenticated USING (profile_id = public.baaki_current_profile_id());

CREATE POLICY usage_events_select_own ON public.usage_events
  FOR SELECT TO authenticated USING (profile_id = public.baaki_current_profile_id());

-- Derived tables are read-only to everyone but the triggers/service role.
CREATE POLICY group_balances_select ON public.group_balances
  FOR SELECT TO authenticated, anon USING (public.is_group_member(group_id));
CREATE POLICY pairwise_balances_select ON public.pairwise_balances
  FOR SELECT TO authenticated, anon USING (public.is_group_member(group_id));
