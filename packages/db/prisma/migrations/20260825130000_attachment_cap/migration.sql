-- A per-EXPENSE ceiling on gallery receipts (A46 attachments).
--
-- The legacy scan cap (20260818160000_receipt_cap) counts rows in `receipts`
-- per GROUP. The A46 gallery is a different surface: many images per expense in
-- `expense_attachments`, added straight to R2 with no count limit — only the
-- 10 MB storage cap held it back. Product now wants the same "free gets a
-- little, paid gets everything" shape here too: a free group may keep a small
-- number of gallery receipts PER EXPENSE, and past that it is a paid feature.
--
-- Same knob table and same paid rule as the legacy cap: one `app_config` row the
-- admin console turns without a deploy, and `baaki_group_is_paid` lifts it for
-- the whole group (a member's subscription or an unexpired group pass). The
-- 10 MB storage cap is unchanged and still applies underneath this — the two are
-- independent ceilings, and free must clear both.

-- ─────────────────────────────────────────────────── the knob ──

INSERT INTO public.app_config (key, value, description)
VALUES (
  'attachment_cap_per_expense',
  2,
  'Free gallery receipts an expense may hold before the group must upgrade.'
)
ON CONFLICT (key) DO NOTHING;

/**
 * The per-expense attachment ceiling, with a floor to fall back to. A missing
 * row (a project the seed never reached) yields a sensible default rather than
 * zero, so a misconfiguration is generous, not a lockout — the same stance as
 * baaki_receipt_cap().
 */
CREATE OR REPLACE FUNCTION public.baaki_attachment_cap()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT value FROM public.app_config WHERE key = 'attachment_cap_per_expense'), 2);
$$;

GRANT EXECUTE ON FUNCTION public.baaki_attachment_cap() TO authenticated, anon, service_role;

-- ────────────────────── may the caller add one more attachment ──

/**
 * May the caller add one more gallery receipt to this expense?
 *   * not a party  → no (only a payer or the author may attach at all);
 *   * paid group   → always yes, the cap does not apply;
 *   * otherwise     → yes while the expense holds fewer than the cap.
 *
 * A bare boolean, the twin of baaki_can_add_receipt. The client uses it to pick
 * the add affordance or the upsell; baaki_attach_expense_attachment enforces the
 * same rule at the real boundary, so a client that ignores this cannot exceed it.
 */
CREATE OR REPLACE FUNCTION public.baaki_can_add_expense_attachment(p_expense_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  IF p_expense_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RETURN false;
  END IF;

  -- Only a party may attach; a non-party gets no affordance and no count.
  IF NOT public.baaki_is_expense_party(p_expense_id) THEN
    RETURN false;
  END IF;

  IF public.baaki_group_is_paid(v_group_id) THEN
    RETURN true;
  END IF;

  RETURN (
    SELECT count(*) FROM public.expense_attachments
     WHERE expense_id = p_expense_id AND deleted_at IS NULL
  ) < public.baaki_attachment_cap();
END
$$;

REVOKE ALL ON FUNCTION public.baaki_can_add_expense_attachment(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_can_add_expense_attachment(uuid) TO authenticated, anon;

-- ──────────────────────── the cap as the real boundary ──
-- Re-declared whole (CREATE OR REPLACE) from the 20260824180000 version — the
-- one that emits the image-audit line — with the per-expense ceiling added just
-- before the insert. A paid group is exempt; a replay of an existing attachment
-- id has already returned above, so the count only ever gates a genuinely new
-- row. The failure cleans up after itself: the client uploaded the bytes to R2
-- before calling this, and its catch path releases that object when the RPC
-- throws, so a refused add leaves nothing behind.

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
  -- (and, because it returns here, never emits a second audit line and is never
  -- re-counted against the cap).
  IF p_attachment_id IS NOT NULL THEN
    SELECT id INTO v_id
    FROM public.expense_attachments
    WHERE id = p_attachment_id AND expense_id = p_expense_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  -- The per-expense ceiling, enforced at the one insert path. A paid group is
  -- exempt; only live (non-deleted) attachments count, so removing one frees a
  -- slot.
  IF NOT public.baaki_group_is_paid(v_group_id)
     AND (SELECT count(*) FROM public.expense_attachments
           WHERE expense_id = p_expense_id AND deleted_at IS NULL)
         >= public.baaki_attachment_cap()
  THEN
    RAISE EXCEPTION 'ATTACHMENT_CAP'
      USING ERRCODE = 'check_violation',
            HINT = 'This expense has reached its free receipt limit; upgrade to add more.';
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
