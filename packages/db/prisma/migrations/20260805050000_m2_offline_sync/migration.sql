-- M2 — offline-first sync (ADR-005 / TDR §4).
--
-- Four things the ledger needs before a client can go offline and come back:
--
--   1. A cursor that moves when a *group itself* changes, not only its rows.
--   2. An idempotency ledger, so replaying a queue is free for every mutation
--      kind rather than only the two that happened to have a natural key.
--   3. Conflict versioning: two people editing the same expense from two
--      aeroplanes must both keep their work, with the loser surfaced.
--   4. Client-chosen primary keys, so a row created offline keeps its identity
--      when it finally reaches the server.

-- ───────────────────────────── 1. groups move their own cursor ──
-- `baaki_stamp_seq` covers rows that belong to a group. Renaming the group, or
-- toggling simplify-debts, changed nothing a client could pull, so a device
-- that was offline during a rename never learned about it.

CREATE OR REPLACE FUNCTION public.baaki_stamp_group_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- `baaki_next_group_seq` bumps this column directly; when it does, NEW is
  -- already ahead of OLD and there is nothing left to do. Any other update —
  -- a rename, an archive — arrives with the two equal and needs a bump.
  IF NEW.updated_seq IS NOT DISTINCT FROM OLD.updated_seq THEN
    NEW.updated_seq := OLD.updated_seq + 1;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER groups_stamp_seq
  BEFORE UPDATE ON public.groups
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_group_seq();

-- ────────────────────────────────── 2. the idempotency ledger ──
-- ADR-005 makes the client-generated UUID the idempotency key. Expenses and
-- settlements already store theirs, but a queued "delete this expense" or "add
-- this ghost" had no record, so a retry after a dropped response re-ran it.
-- Storing the original result means a replay returns the same answer as the
-- first attempt rather than merely avoiding damage.

CREATE TABLE public.sync_mutations (
  client_mutation_id uuid PRIMARY KEY,
  profile_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  group_id           uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  kind               text NOT NULL,
  result             jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_mutations_profile_idx ON public.sync_mutations (profile_id, applied_at DESC);

-- No policies at all: only the service role (which bypasses RLS) may read or
-- write this, because it is the edge function's own bookkeeping (ADR-013).
ALTER TABLE public.sync_mutations ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────── 3. conflict versioning ──
-- TDR §4.4: two edits to the same expense both become versions; the later
-- server receipt wins as `current_version_id`, and the loser is surfaced in the
-- activity feed so the person whose edit was replaced can see and restore it.
--
-- The signature changes, so the old one is dropped rather than overloaded —
-- an ambiguous overload picked at runtime is exactly the kind of surprise a
-- money path cannot afford.

DROP FUNCTION IF EXISTS public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char, bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid
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
  /** The version the client believed it was editing. NULL = an online write. */
  p_base_version_no    int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing      RECORD;
  v_version_no    int;
  v_version_id    uuid;
  v_is_new        boolean := false;
  v_row           jsonb;
  v_member        uuid;
  v_unknown       int;
  v_superseded    RECORD;
  v_conflict      boolean := false;
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
        INTO v_superseded
        FROM public.expense_versions ev
        JOIN public.expenses e ON e.id = ev.expense_id AND e.current_version_id = ev.id
       WHERE ev.expense_id = p_expense_id;
    END IF;
  END IF;

  INSERT INTO public.expense_versions
    (expense_id, version_no, author_member_id, description, category, expense_date,
     currency, amount, split_type, split_params, receipt_id, notes, client_mutation_id)
  VALUES
    (p_expense_id, v_version_no, p_author_member_id, p_description, p_category, p_expense_date,
     upper(p_currency), p_amount, p_split_type::"SplitType", p_split_params, p_receipt_id,
     p_notes, p_client_mutation_id)
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
      'versionNo', v_version_no
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
        'supersededVersionNo', v_superseded.version_no,
        'supersededAuthorMemberId', v_superseded.author_member_id,
        'supersededDescription', v_superseded.description,
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
    'supersededVersionNo', CASE WHEN v_conflict THEN v_superseded.version_no ELSE NULL END
  );
END
$$;

REVOKE ALL ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char, bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid, int
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.baaki_apply_expense(
  uuid, uuid, uuid, text, text, date, char, bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid, int
) TO service_role;

-- ──────────────────────────── 4. identities chosen on the client ──
-- A group or a ghost created in aeroplane mode already has a UUID, and every
-- queued mutation that references it uses that UUID. If the server minted a
-- different one on arrival, the rest of the queue would point at nothing.
-- Passing the id in makes the insert idempotent by primary key.

DROP FUNCTION IF EXISTS public.baaki_create_group(text, text, char, text, boolean);

CREATE OR REPLACE FUNCTION public.baaki_create_group(
  p_name text,
  p_type text DEFAULT 'other',
  p_currency char(3) DEFAULT 'INR',
  p_emoji text DEFAULT NULL,
  p_simplify boolean DEFAULT true,
  /** Client-chosen id, so a group created offline keeps its identity. */
  p_group_id uuid DEFAULT NULL
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

  -- Replaying the create half of a queue must return the same group, not a
  -- second one — and must not let somebody else's id be hijacked.
  IF p_group_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.groups WHERE id = p_group_id) THEN
    IF NOT public.is_group_member(p_group_id, v_profile_id) THEN
      RAISE EXCEPTION 'GROUP_EXISTS: that group id is already taken'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN p_group_id;
  END IF;

  INSERT INTO public.groups (id, name, type, default_currency, cover_emoji, simplify_debts, created_by)
  VALUES (COALESCE(p_group_id, gen_random_uuid()), trim(p_name), p_type::"GroupType",
          upper(p_currency), p_emoji, p_simplify, v_profile_id)
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

-- ADR-006: a ghost is a real participant who simply hasn't joined yet, and one
-- can be added with no network at all.
CREATE OR REPLACE FUNCTION public.baaki_add_ghost_member(
  p_group_id  uuid,
  p_name      text,
  p_member_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_id uuid := public.baaki_current_profile_id();
  v_member_id  uuid;
BEGIN
  IF v_profile_id IS NULL OR NOT public.is_group_member(p_group_id, v_profile_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'INVALID_NAME: a ghost needs a name' USING ERRCODE = 'check_violation';
  END IF;

  IF p_member_id IS NOT NULL THEN
    SELECT id INTO v_member_id FROM public.group_members
     WHERE id = p_member_id AND group_id = p_group_id;
    IF FOUND THEN
      RETURN v_member_id;  -- replay
    END IF;
  END IF;

  INSERT INTO public.group_members (id, group_id, ghost_name, joined_via)
  VALUES (COALESCE(p_member_id, gen_random_uuid()), p_group_id, trim(p_name), 'ghost')
  RETURNING id INTO v_member_id;

  RETURN v_member_id;
END
$$;

-- ──────────────────────────────────── 5. what a client may pull ──
-- The pull is deliberately a plain RLS-scoped read rather than a privileged
-- function: a client can only ever receive rows it was already allowed to see,
-- and adding a table to the sync set cannot accidentally widen that.
--
-- This index is what keeps "everything since seq N" cheap as a group grows.

CREATE INDEX IF NOT EXISTS expenses_group_seq_idx
  ON public.expenses (group_id, updated_seq);
CREATE INDEX IF NOT EXISTS group_members_group_seq_idx
  ON public.group_members (group_id, updated_seq);
CREATE INDEX IF NOT EXISTS settlements_group_seq_idx
  ON public.settlements (group_id, updated_seq);
CREATE INDEX IF NOT EXISTS activity_log_group_seq_idx
  ON public.activity_log (group_id, updated_seq);
