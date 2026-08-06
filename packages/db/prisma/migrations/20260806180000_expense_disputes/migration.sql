-- Declining an expense somebody else added.
--
-- Editing has always been open to every member: `expenses_update` and
-- `expense_versions_insert` check membership, not authorship, because the
-- person who spots that dinner was ₹1,800 and not ₹1,300 is usually not the
-- person who typed it. Correcting somebody's expense is not an act of
-- aggression, and the version history means nothing is lost when they do.
--
-- Declining is the case editing cannot cover: "I wasn't at that dinner." The
-- obvious implementation — take me out of the split — is the one thing that
-- must not be built, because a share you can remove unilaterally is a debt you
-- can delete, and the whole ledger is worth exactly as much as that is
-- impossible.
--
-- So a decline is a *claim*, not a mutation. It is recorded against the
-- expense, everybody can see it, the person who entered it is told, and the
-- balances do not move until somebody actually changes the expense. That is the
-- same trade ADR-007 makes for settlements: confirmation here is social, not
-- cryptographic, and the app's job is to make the disagreement visible rather
-- than to adjudicate it.
--
-- Resolution happens three ways:
--   * somebody edits the expense — the thing disputed no longer exists, so
--     open disputes on it close themselves;
--   * the disputer withdraws it;
--   * the author or an admin rejects it, with a note.

-- ────────────────────────────────────────────────────────── 1. the claim ──
-- One row per person per expense rather than one per complaint: this is
-- somebody's position on an expense, and they only have one at a time. The
-- history of how that position changed lives in `activity_log`, which is the
-- append-only record (ADR-004).

CREATE TABLE IF NOT EXISTS public.expense_disputes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id  UUID NOT NULL,
  member_id   UUID NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  resolved_by_member_id UUID,
  resolution_note TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT expense_disputes_status_check
    CHECK (status IN ('open', 'resolved', 'withdrawn', 'rejected')),
  CONSTRAINT expense_disputes_expense_id_member_id_key UNIQUE (expense_id, member_id)
);

ALTER TABLE public.expense_disputes
  DROP CONSTRAINT IF EXISTS "expense_disputes_expense_id_fkey",
  DROP CONSTRAINT IF EXISTS "expense_disputes_member_id_fkey",
  DROP CONSTRAINT IF EXISTS "expense_disputes_resolved_by_member_id_fkey";

ALTER TABLE public.expense_disputes
  ADD CONSTRAINT "expense_disputes_expense_id_fkey" FOREIGN KEY ("expense_id")
    REFERENCES public.expenses("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "expense_disputes_member_id_fkey" FOREIGN KEY ("member_id")
    REFERENCES public.group_members("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "expense_disputes_resolved_by_member_id_fkey" FOREIGN KEY ("resolved_by_member_id")
    REFERENCES public.group_members("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS expense_disputes_expense_id_status_idx
  ON public.expense_disputes (expense_id, status);

COMMENT ON TABLE public.expense_disputes IS
  'Somebody saying an expense is wrong. Visible to the group; never changes a balance on its own.';

ALTER TABLE public.expense_disputes ENABLE ROW LEVEL SECURITY;

-- Read-only to the group. Every write goes through the RPCs below, which is
-- what stops somebody resolving a dispute against themselves or filing one in
-- another member's name.
CREATE POLICY expense_disputes_select ON public.expense_disputes
  FOR SELECT TO authenticated, anon
  USING (public.is_group_member(
    (SELECT group_id FROM public.expenses WHERE id = expense_id)
  ));

-- ───────────────────────────────────────────── 2. raising and withdrawing ──

CREATE OR REPLACE FUNCTION public.baaki_dispute_expense(
  p_expense_id UUID,
  p_reason     TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id     UUID;
  v_actor        UUID;
  v_dispute_id   UUID;
  v_raised_at    TIMESTAMPTZ;
  v_author       UUID;
  v_author_pid   UUID;
  v_description  TEXT;
  v_group_name   TEXT;
  v_actor_name   TEXT;
BEGIN
  SELECT e.group_id, v.author_member_id, v.description
    INTO v_group_id, v_author, v_description
  FROM public.expenses e
  LEFT JOIN public.expense_versions v ON v.id = e.current_version_id
  WHERE e.id = p_expense_id AND e.deleted_at IS NULL;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.baaki_my_member_id(v_group_id);
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: only a member of the group can dispute its expenses'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Re-raising replaces the previous position rather than stacking another row.
  --
  -- `updated_at` moves only when something actually changed. Calling this twice
  -- with the same complaint is a retry and must be silent; raising it again
  -- after it was rejected is a new complaint and must not be.
  INSERT INTO public.expense_disputes AS d (expense_id, member_id, reason, status)
  VALUES (p_expense_id, v_actor, NULLIF(btrim(p_reason), ''), 'open')
  ON CONFLICT (expense_id, member_id) DO UPDATE
    SET reason = EXCLUDED.reason,
        status = 'open',
        resolved_by_member_id = NULL,
        resolution_note = NULL,
        resolved_at = NULL,
        updated_at = CASE
          WHEN d.status = 'open' AND d.reason IS NOT DISTINCT FROM EXCLUDED.reason
          THEN d.updated_at
          ELSE now()
        END
  RETURNING d.id, d.updated_at INTO v_dispute_id, v_raised_at;

  SELECT COALESCE(p.display_name, m.ghost_name) INTO v_actor_name
  FROM public.group_members m
  LEFT JOIN public.profiles p ON p.id = m.profile_id
  WHERE m.id = v_actor;

  SELECT name INTO v_group_name FROM public.groups WHERE id = v_group_id;

  INSERT INTO public.activity_log
    (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES
    (v_group_id, v_actor, 'disputed', 'expense', p_expense_id,
     jsonb_build_object('description', v_description, 'reason', NULLIF(btrim(p_reason), '')));

  -- The person who entered it is the person who can fix it.
  SELECT profile_id INTO v_author_pid FROM public.group_members WHERE id = v_author;
  IF v_author_pid IS NOT NULL AND v_author IS DISTINCT FROM v_actor THEN
    PERFORM public.baaki_notify(
      v_author_pid, v_group_id, 'expense_disputed',
      COALESCE(v_actor_name, 'Someone') || ' says an expense is wrong',
      COALESCE(v_description, 'An expense') || ' — have a look',
      'baaki://group/' || v_group_id::text || '/expense/' || p_expense_id::text,
      jsonb_build_object('counterparty', v_actor_name, 'group', v_group_name,
                         'description', v_description, 'expenseId', p_expense_id),
      'dispute:' || v_dispute_id::text || ':raised:' || v_raised_at::text
    );
  END IF;

  RETURN v_dispute_id;
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_withdraw_dispute(p_expense_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id UUID;
  v_actor    UUID;
  v_updated  INTEGER;
BEGIN
  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.baaki_my_member_id(v_group_id);

  UPDATE public.expense_disputes
     SET status = 'withdrawn', resolved_at = now(), updated_at = now(),
         resolved_by_member_id = v_actor
   WHERE expense_id = p_expense_id AND member_id = v_actor AND status = 'open';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RAISE EXCEPTION 'NOT_YOUR_DISPUTE: you have no open dispute on this expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.activity_log
    (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_actor, 'withdrew_dispute', 'expense', p_expense_id, '{}'::jsonb);
END
$$;

-- ──────────────────────────────────────────────────────── 3. answering it ──

CREATE OR REPLACE FUNCTION public.baaki_resolve_dispute(
  p_dispute_id UUID,
  p_accept     BOOLEAN,
  p_note       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense_id  UUID;
  v_group_id    UUID;
  v_author      UUID;
  v_actor       UUID;
  v_disputer    UUID;
  v_disputer_pid UUID;
  v_description TEXT;
  v_group_name  TEXT;
BEGIN
  SELECT d.expense_id, d.member_id, e.group_id, v.author_member_id, v.description
    INTO v_expense_id, v_disputer, v_group_id, v_author, v_description
  FROM public.expense_disputes d
  JOIN public.expenses e ON e.id = d.expense_id
  LEFT JOIN public.expense_versions v ON v.id = e.current_version_id
  WHERE d.id = p_dispute_id AND d.status = 'open';

  IF v_expense_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no open dispute with that id' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.baaki_my_member_id(v_group_id);

  -- The person who entered the expense, or an admin. Not the disputer: nobody
  -- gets to rule on their own complaint, in either direction.
  IF v_actor IS NULL
     OR v_actor = v_disputer
     OR (v_actor IS DISTINCT FROM v_author AND NOT public.is_group_admin(v_group_id))
  THEN
    RAISE EXCEPTION 'NOT_YOURS_TO_RESOLVE: only the person who added the expense, or an admin, can answer this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_disputes
     SET status = CASE WHEN p_accept THEN 'resolved' ELSE 'rejected' END,
         resolution_note = NULLIF(btrim(p_note), ''),
         resolved_by_member_id = v_actor,
         resolved_at = now(),
         updated_at = now()
   WHERE id = p_dispute_id;

  SELECT name INTO v_group_name FROM public.groups WHERE id = v_group_id;

  INSERT INTO public.activity_log
    (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES
    (v_group_id, v_actor,
     CASE WHEN p_accept THEN 'accepted_dispute' ELSE 'rejected_dispute' END,
     'expense', v_expense_id,
     jsonb_build_object('description', v_description, 'note', NULLIF(btrim(p_note), '')));

  SELECT profile_id INTO v_disputer_pid FROM public.group_members WHERE id = v_disputer;
  IF v_disputer_pid IS NOT NULL THEN
    PERFORM public.baaki_notify(
      v_disputer_pid, v_group_id, 'expense_dispute_resolved',
      CASE WHEN p_accept THEN 'Your correction was accepted' ELSE 'Your correction was declined' END,
      COALESCE(v_description, 'An expense'),
      'baaki://group/' || v_group_id::text || '/expense/' || v_expense_id::text,
      jsonb_build_object('group', v_group_name, 'description', v_description,
                         'accepted', p_accept, 'note', NULLIF(btrim(p_note), '')),
      'dispute:' || p_dispute_id::text || ':resolved'
    );
  END IF;
END
$$;

-- ──────────────────────────────────────── 4. an edit answers it by itself ──
-- A new version means the expense being complained about no longer exists.
-- Leaving the dispute open against a row that has changed would leave a red
-- flag on an expense nobody can find fault with any more.

CREATE OR REPLACE FUNCTION public.baaki_close_disputes_on_new_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.expense_disputes
     SET status = 'resolved',
         resolution_note = 'The expense was edited',
         resolved_at = now(),
         updated_at = now(),
         resolved_by_member_id = NEW.author_member_id
   WHERE expense_id = NEW.expense_id AND status = 'open';
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS expense_versions_close_disputes ON public.expense_versions;
CREATE TRIGGER expense_versions_close_disputes
  AFTER INSERT ON public.expense_versions
  FOR EACH ROW
  -- Only an edit. Version 1 is the expense being created, and nothing can have
  -- been disputed about it yet.
  WHEN (NEW.version_no > 1)
  EXECUTE FUNCTION public.baaki_close_disputes_on_new_version();

GRANT EXECUTE ON FUNCTION
  public.baaki_dispute_expense(uuid, text),
  public.baaki_withdraw_dispute(uuid),
  public.baaki_resolve_dispute(uuid, boolean, text)
TO authenticated, anon;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename = 'expense_disputes'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.expense_disputes;
  END IF;
END
$$;
