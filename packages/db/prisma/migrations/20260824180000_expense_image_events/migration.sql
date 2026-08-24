-- An append-only audit line for an expense's images (A46 part 2): who added or
-- removed a receipt or an attachment, and when.
--
-- A bill's photo is evidence. Swapping or deleting it silently changes what the
-- expense claims after the fact, and today that leaves no trace: the kept bill
-- (the `receipts` R2 object at `<groupId>/<expenseId>.jpg`) has no DB row at
-- all, and an attachment removal records `deleted_at` but not who. This table is
-- the trail — one immutable line per add/remove — so the group can read an
-- image's history the same way ADR-004 lets it read the amount's. A correction
-- is another line, never an erasure; there is no soft-delete here.
--
-- It is a group's shared, non-money list, so it rides the same offline mirror as
-- comments and the plan: an `updated_seq` the /sync pull walks, stamped by the
-- shared `baaki_stamp_seq` trigger. There is no tombstone because a row is never
-- retracted.
--
-- Visibility inherits the image it describes. A `parties` attachment is hidden
-- from non-parties (#407); its events must be too, or the mere line "someone
-- removed an attachment" would leak that a private attachment ever existed. The
-- SELECT policy embeds `baaki_is_expense_party`, exactly like the attachment
-- table's own policy, so a non-party's read returns zero party rows. A receipt
-- is group-wide, so its events are `group` and everybody in the group sees them.
--
-- Writes are RPC-only: the actor is taken from the session (`baaki_my_member_id`)
-- so a line cannot be forged, and a direct PostgREST insert has no privilege.

CREATE TABLE IF NOT EXISTS public.expense_image_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
  expense_id      uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  /** Who did it. SET NULL if that membership is later removed — the line
      survives the person leaving, shown as "someone". */
  actor_member_id uuid REFERENCES public.group_members(id) ON DELETE SET NULL ON UPDATE CASCADE,
  /** `receipt` (the group-wide bill) or `attachment`. */
  kind            text NOT NULL,
  /** `added` or `removed`. */
  action          text NOT NULL,
  /** `group` or `parties` — mirrors the image's own visibility. */
  visibility      text NOT NULL DEFAULT 'group',
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Sync plumbing (ADR-005), identical to expense_comments / trip_plan_items.
  updated_seq     bigint NOT NULL DEFAULT 0,

  CONSTRAINT expense_image_events_kind_ck CHECK (kind IN ('receipt', 'attachment')),
  CONSTRAINT expense_image_events_action_ck CHECK (action IN ('added', 'removed')),
  CONSTRAINT expense_image_events_visibility_ck CHECK (visibility IN ('group', 'parties'))
);

CREATE INDEX IF NOT EXISTS expense_image_events_group_id_updated_seq_idx
  ON public.expense_image_events (group_id, updated_seq);
-- The expense-detail trail reads by expense, oldest first.
CREATE INDEX IF NOT EXISTS expense_image_events_expense_idx
  ON public.expense_image_events (expense_id, created_at);

DROP TRIGGER IF EXISTS expense_image_events_stamp_seq ON public.expense_image_events;
CREATE TRIGGER expense_image_events_stamp_seq
  BEFORE INSERT OR UPDATE ON public.expense_image_events
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

ALTER TABLE public.expense_image_events ENABLE ROW LEVEL SECURITY;

-- A group member sees an event only when the image it describes is one they may
-- see: a `group` event is group-wide; a `parties` event needs the caller to be
-- a party to the expense. Same shape as the expense_attachments SELECT policy.
CREATE POLICY expense_image_events_select ON public.expense_image_events
  FOR SELECT TO anon, authenticated
  USING (
    public.is_group_member(group_id)
    AND (visibility = 'group' OR public.baaki_is_expense_party(expense_id))
  );

-- No write policy or privilege: the RPCs below are the only way in.
REVOKE ALL ON public.expense_image_events FROM anon, authenticated;
GRANT SELECT ON public.expense_image_events TO anon, authenticated;

-- ────────────────────────────────────────────────────────────── writing ──

/**
 * Record a receipt add/remove. The kept bill has no table and its upload goes
 * straight to R2, so the client calls this after a successful put/delete. A
 * receipt is group-wide, so the event is always `group`; kind is fixed here so
 * this door can never be used to fabricate a party-only attachment line. The
 * event id is the caller's, so a retried call is idempotent (ON CONFLICT).
 */
CREATE OR REPLACE FUNCTION public.baaki_log_receipt_event(
  p_event_id   uuid,
  p_group_id   uuid,
  p_expense_id uuid,
  p_action     text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_member   uuid;
BEGIN
  IF p_action NOT IN ('added', 'removed') THEN
    RAISE EXCEPTION 'INVALID_ACTION: added or removed' USING ERRCODE = 'check_violation';
  END IF;

  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL OR v_group_id <> p_group_id THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense in this group' USING ERRCODE = 'no_data_found';
  END IF;

  -- Membership is the authorisation: only a member of the group may write a line
  -- about it, and their identity is the session's, not a client argument.
  v_member := public.baaki_my_member_id(p_group_id);
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: only a group member may log this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.expense_image_events
    (id, group_id, expense_id, actor_member_id, kind, action, visibility)
  VALUES
    (p_event_id, p_group_id, p_expense_id, v_member, 'receipt', p_action, 'group')
  ON CONFLICT (id) DO NOTHING;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_log_receipt_event(uuid, uuid, uuid, text)
  TO authenticated, anon;

-- ─────────────────────────────────────────── attachment RPCs, now audited ──
-- The attach/remove RPCs already know the expense, the group, the actor and the
-- visibility, so they emit their own event inline — the trail cannot be skipped
-- by a client, and a `parties` attachment's event carries `parties` so it stays
-- hidden from non-parties. Re-declared verbatim from 20260824150000 with the
-- single INSERT added on the path that actually changed a row.

CREATE OR REPLACE FUNCTION public.baaki_attach_expense_attachment(
  p_expense_id   uuid,
  p_storage_path text,
  p_visibility   text DEFAULT 'group',
  p_attachment_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_member   uuid;
  v_id       uuid;
BEGIN
  IF coalesce(btrim(p_storage_path), '') = '' THEN
    RAISE EXCEPTION 'INVALID_PATH: an attachment needs a stored image'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_visibility NOT IN ('group', 'parties') THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY: group or parties' USING ERRCODE = 'check_violation';
  END IF;

  -- The key MUST be scoped to this expense: `<expenseId>/…` (see the proof RPC).
  IF p_storage_path NOT LIKE p_expense_id::text || '/%' THEN
    RAISE EXCEPTION 'INVALID_PATH: the key must be scoped to its expense'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Authorise before resolving the client id (an existence oracle otherwise).
  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.baaki_is_expense_party(p_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a payer or the author may attach to this expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Replay bound to the subject: same id + same expense returns the existing row
  -- (and, because it returns here, never emits a second audit line).
  IF p_attachment_id IS NOT NULL THEN
    SELECT id INTO v_id
    FROM public.expense_attachments
    WHERE id = p_attachment_id AND expense_id = p_expense_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  v_member := public.baaki_my_member_id(v_group_id);

  INSERT INTO public.expense_attachments
    (id, expense_id, group_id, uploader_member_id, storage_path, visibility)
  VALUES
    (COALESCE(p_attachment_id, gen_random_uuid()), p_expense_id, v_group_id, v_member,
     btrim(p_storage_path), p_visibility)
  RETURNING id INTO v_id;

  INSERT INTO public.expense_image_events
    (id, group_id, expense_id, actor_member_id, kind, action, visibility)
  VALUES
    (gen_random_uuid(), v_group_id, p_expense_id, v_member, 'attachment', 'added', p_visibility);

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_attach_expense_attachment(uuid, text, text, uuid)
  TO authenticated, anon;

/** Remove an expense attachment. A party may; soft delete, twice is a no-op. The
    audit line is emitted only when a live row actually flips to deleted, so a
    repeated remove does not stutter the trail. It carries the attachment's own
    visibility, so a `parties` removal stays hidden from non-parties. */
CREATE OR REPLACE FUNCTION public.baaki_remove_expense_attachment(p_attachment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense_id uuid;
  v_group_id   uuid;
  v_visibility text;
BEGIN
  SELECT expense_id, group_id, visibility
    INTO v_expense_id, v_group_id, v_visibility
  FROM public.expense_attachments WHERE id = p_attachment_id;
  IF v_expense_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.baaki_is_expense_party(v_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may remove this attachment'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_attachments
     SET deleted_at = now()
   WHERE id = p_attachment_id AND deleted_at IS NULL;

  IF FOUND THEN
    INSERT INTO public.expense_image_events
      (id, group_id, expense_id, actor_member_id, kind, action, visibility)
    VALUES
      (gen_random_uuid(), v_group_id, v_expense_id,
       public.baaki_my_member_id(v_group_id), 'attachment', 'removed', v_visibility);
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_remove_expense_attachment(uuid) TO authenticated, anon;
