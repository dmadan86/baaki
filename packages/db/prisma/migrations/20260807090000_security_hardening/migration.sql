-- Closing eight holes found by attacking the deployed schema rather than
-- reading it. Every one of them is the same mistake wearing different clothes:
--
--   `is_group_member()` answers "may you touch this group".
--   Several policies used it to answer "is this row about you".
--
-- The RPCs ask the second question correctly — `baaki_record_settlement`
-- refuses a non-member, `baaki_confirm_settlement` refuses anyone but the
-- payee. But PostgREST exposes the tables underneath those functions, and the
-- policies on those tables asked only the first question. So the RPC was never
-- the only door; it was just the polite one.
--
-- The shape of the fix, everywhere below: **if no client writes a table
-- directly, no client should be able to.** Every write in this app already
-- goes through a SECURITY DEFINER function or an edge function holding the
-- service role — verified by reading every `.from('<table>')` in `apps/` and
-- `supabase/functions/` — so revoking the privilege costs the app nothing and
-- removes the whole class of attack rather than patching one predicate.

-- ─────────────────────────────────────── 1. forging a settled debt (CRITICAL)
--
-- `settlements_insert` checked group membership and nothing else. Not that
-- `from_member_id` was the caller. Not that `status` was 'initiated'. And
-- `baaki_settlement_transition` reads OLD, so it only fires on UPDATE — an
-- INSERT arriving at 'confirmed' was never examined by it.
--
--   INSERT INTO settlements (group_id, from_member_id, to_member_id, currency,
--                            amount, method, status, confirmed_at)
--   VALUES ($group, $me, $them, 'INR', 10000, 'upi', 'confirmed', now());
--
-- One request. The debtor's balance and the creditor's both went to zero: the
-- debt was gone, with no payment and no confirmation from the person owed.
--
-- `settlements_update` was the same hole by another route — a member who is
-- neither payer nor payee could move somebody else's settlement from
-- 'initiated' to 'confirmed', which is exactly what `baaki_confirm_settlement`
-- exists to prevent.

DROP POLICY IF EXISTS settlements_insert ON public.settlements;
DROP POLICY IF EXISTS settlements_update ON public.settlements;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.settlements FROM anon, authenticated;

-- Allocations name which expenses a payment pays off. They cannot change what
-- anybody owes in total, but they are written only by `baaki_record_settlement`
-- and there is no reason for a client to reach them.
DROP POLICY IF EXISTS settlement_allocations_insert ON public.settlement_allocations;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.settlement_allocations FROM anon, authenticated;

-- ──────────────────────────────────── 2. forging somebody else's actions (HIGH)
--
-- `activity_log_insert` checked group membership and left `actor_member_id`
-- free, so any member could write "Priya settled up" into the feed. The table
-- is append-only by trigger, so nobody but the service role could take it back
-- out again. The only writer that has ever existed is `invite-accept`, holding
-- the service role, plus the SECURITY DEFINER functions.

DROP POLICY IF EXISTS activity_log_insert ON public.activity_log;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.activity_log FROM anon, authenticated;

-- ──────────────────────────────── 3. the same forgery on the ledger itself
--
-- Not in the original report, found while fixing it and the identical defect:
-- `expense_versions.author_member_id` was as free as `actor_member_id` was, so
-- an edit could be attributed to a member who did not make it — and the
-- version rows are append-only, so the attribution is permanent.
--
-- Every expense write in this app goes through `baaki_apply_expense`, which
-- recomputes the shares with @waves/core and stamps the author itself. Nothing
-- in `apps/` writes these four tables.

DROP POLICY IF EXISTS expenses_insert ON public.expenses;
DROP POLICY IF EXISTS expenses_update ON public.expenses;
DROP POLICY IF EXISTS expense_versions_insert ON public.expense_versions;
DROP POLICY IF EXISTS expense_shares_insert ON public.expense_shares;
DROP POLICY IF EXISTS expense_payers_insert ON public.expense_payers;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expenses FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expense_versions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expense_shares FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expense_payers FROM anon, authenticated;

-- ───────────────────────────────────── 4. promoting yourself to admin (HIGH)
--
-- `group_members_update_self` allowed a member to update their own row and
-- pinned nothing within it, so `UPDATE group_members SET role='admin'` on your
-- own id worked and `is_group_admin()` agreed afterwards.
--
-- A policy cannot see OLD, so the pinning has to be a trigger. The two things
-- the app legitimately changes on a membership row are `ghost_name`/`vpa`
-- (`updateMember`) and `left_at` (`leaveGroup`); nothing in the product changes
-- a role at all, so for a client the answer is simply no.

CREATE OR REPLACE FUNCTION public.baaki_guard_membership_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Service-role jobs, SECURITY DEFINER functions (which run as the owner) and
  -- migrations are the paths that legitimately move somebody between roles or
  -- attach a profile to a ghost. A signed-in client is never one of them.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a role is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Claiming a ghost is `invite-accept`'s job, transactionally and against a
  -- token. Doing it by UPDATE would take over somebody's whole history.
  IF NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: claim a ghost through an invite, not an update'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a membership cannot move between groups'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS group_members_guard_columns ON public.group_members;
CREATE TRIGGER group_members_guard_columns
  BEFORE UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.baaki_guard_membership_columns();

-- ─────────────────────── 5. writing into a stranger's group (CRITICAL)
--
-- `baaki_apply_expense` is SECURITY DEFINER and was granted to anon and
-- authenticated. It checks that every member id in payers and shares belongs
-- to the group — and never checked whether *the caller* did. A profile that
-- had never been in the group wrote a ₹600 expense into it and moved every
-- balance. A former member needs nothing but their own old member id: `left_at`
-- stops `is_group_member`, and this function never asked it.
--

-- The guard goes *inside* the function rather than on the grant. Revoking
-- EXECUTE was tried first and is too blunt: a member adding an expense to
-- their own group is the entire product, and this function is how it happens,
-- whether the call arrives through `expense-write` or straight from a client.
-- What was missing was never "who may call it" but "on whose behalf".
--
-- The discriminator is the JWT subject, not the database role. `current_user`
-- would be the obvious choice and is the wrong one: this runs inside a
-- SECURITY DEFINER function, where `current_user` is already the owner no
-- matter who called — a guard written that way returns early every time and
-- protects nothing. (It did. The tests caught it.)
--
-- `baaki_current_profile_id()` is null exactly when there is no human on the
-- other end: the service-role key carries no `sub`, and neither does a cron
-- job or a migration. When it is null there is no membership to check and
-- nothing to check it against; when it is set, that person must be a member.

CREATE OR REPLACE FUNCTION public.baaki_assert_expense_caller(
  p_group_id uuid,
  p_author_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me      uuid;
  v_profile uuid := public.baaki_current_profile_id();
BEGIN
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- An expense records who wrote it, and the version rows are append-only, so
  -- a wrong name on one is permanent. A client may only ever write as itself.
  v_me := public.baaki_my_member_id_for(p_group_id, v_profile);
  IF p_author_member_id IS NOT NULL AND p_author_member_id IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'NOT_THE_AUTHOR: an expense is recorded as written by whoever wrote it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

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
  -- Added by 20260807090000_security_hardening. This function is SECURITY
  -- DEFINER and callable by clients, and until now it verified only that the
  -- member ids it was *given* belonged to the group — never that the caller
  -- did. A profile that had never joined wrote an expense into a stranger’s
  -- group and moved every balance; a former member needed nothing but their
  -- own old member id, because left_at stops is_group_member and this
  -- function never asked it.
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

-- ──────────────────────────── 6. an unauthenticated recompute (LOW)
--
-- `baaki_refresh_group_balances(group_id)` was callable by anyone on any group.
-- The recompute is idempotent so nothing corrupts, but it is a CPU amplifier
-- pointed at somebody else's group.
--
-- It cannot simply be revoked: `baaki_touch_balances` is an ordinary trigger
-- function, so it runs as whoever did the INSERT and would lose the privilege
-- with them. Making the trigger SECURITY DEFINER lets the refresh keep working
-- while the entry point closes. The group id it refreshes is read off the row
-- being written, never from an argument, so there is nothing for a caller to
-- point somewhere else.

CREATE OR REPLACE FUNCTION public.baaki_touch_balances()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

REVOKE EXECUTE ON FUNCTION public.baaki_refresh_group_balances(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_refresh_group_balances(uuid) TO service_role;

-- ─────────────────────────────── 7. an authorization branch nothing mints
--
-- `is_group_member` granted access to any group id listed in the JWT's
-- `app_metadata.baaki_groups`. Choosing `app_metadata` over `user_metadata` was
-- right — a user cannot set it — but nothing in this repository has ever
-- written that claim. Guests join by `signInAnonymously()` and then get a real
-- `group_members` row from `invite-accept`.
--
-- So it is a live authorization path with no issuer, no expiry, and no way to
-- revoke: a claim written by any future code (or any operator with the admin
-- API) would confer permanent membership that leaving the group, revoking the
-- invite and deleting the member row would all fail to remove. Dead
-- authorization code is worse than none, because it reads like a feature.
--
-- Membership is a row. That is the whole rule now.

CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid)
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
  )
$$;

DROP FUNCTION IF EXISTS public.baaki_scoped_group_ids();

-- ─────────────────────────────── 8. the migration ledger (HIGH)
--
-- Prisma creates `_prisma_migrations` itself, outside the migration that turns
-- RLS on, so it was the one table in `public` with RLS disabled — while
-- Supabase's default `GRANT ALL ON ALL TABLES IN SCHEMA public` still applied
-- to it. Anyone holding the anon key, which ships in every binary, could read
-- it and write it. Verified against the deployed project: 25 migration names
-- came back to an unauthenticated request, and an INSERT probe was refused by a
-- not-null constraint (23502) rather than by permissions (42501).
--
-- Wiping it does not touch a single row of anybody's money. It breaks the next
-- deploy: `migrate deploy` re-applies migrations that already ran, and
-- `migrate status` reports a database that does not exist.
--
-- Prisma connects as the table's owner, which is exempt from RLS unless FORCE
-- is set, so migrations are unaffected.

REVOKE ALL ON public._prisma_migrations FROM anon, authenticated;
ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────── not changed
--
-- An ordinary member can still rename a group. That is the product working:
-- there is no admin-only editing anywhere in the app, and making renaming a
-- privilege would be a design decision, not a security fix. It is recorded
-- here so the next person knows it was looked at and left.
