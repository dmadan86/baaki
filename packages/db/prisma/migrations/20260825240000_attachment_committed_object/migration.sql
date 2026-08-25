-- Metadata may only point at bytes that were really uploaded (A46 integrity).
--
-- The attach / replace RPCs validated the shape of a storage key (scoped to its
-- expense or settlement), the caller's party-ship, the visibility and the cap —
-- but never that a committed object actually exists at that key. So a party (a
-- buggy retry, or a malicious client bypassing the happy-path upload) could
-- record an attachment or a settlement proof pointing at a path that was never
-- PUT to R2: a typo, a key from a different logical bucket, or one that was only
-- ever a `pending` reservation and never committed. The row then references
-- nothing; sync distributes the broken pointer, the audit trail lies, and the
-- storage ledger and the metadata drift apart.
--
-- The real upload path already writes the truth: `r2-sign` reserves the object
-- (`storage_objects.pending = true`), the client PUTs the bytes, then `commit`
-- clears `pending` via `baaki_storage_record`. Only AFTER that does the client
-- call the attach RPC. So a committed `storage_objects` row for (bucket, path)
-- is exactly the proof the bytes exist — and it is the invariant we now require
-- at the one boundary the client cannot skip (ADR-013: the SECURITY DEFINER RPC
-- is the enforcement point, a client-side check is only an affordance).
--
-- The subject-scoping of the key (`<expenseId>/…` / `<settlementId>/…`) is still
-- checked in each RPC, so the committed-object check needs only confirm the
-- object is real and committed in the RIGHT logical bucket; the RPC's own prefix
-- check ties it to the right subject. `expense_attachments` map to the
-- `expense-attachments` bucket and `settlement_proofs` to `settlement-proofs`
-- (supabase/functions/_shared/r2.ts), and the stored `storage_path` equals the
-- ledger `path` for that bucket (r2-sign records the same string), so the match
-- is an exact (logical_bucket, path) lookup.

-- ─────────────────────────────── the shared committed-object guard ──

/**
 * Require a committed (non-pending) object at (logical_bucket, path), or raise.
 *
 * One helper for both receipt attachments and settlement proofs — the check is
 * identical, only the bucket differs — so the invariant lives in exactly one
 * place. A `pending` reservation does NOT satisfy it: a presign the client never
 * committed is not an uploaded image, and admitting it would let "reserve, never
 * PUT" leave a row pointing at bytes that are not there.
 *
 * SECURITY DEFINER so it can read `storage_objects`, which is service-role-only
 * (no client policy); it returns nothing and reveals nothing — a boolean-shaped
 * gate its SECURITY DEFINER callers already stand in front of.
 */
CREATE OR REPLACE FUNCTION public.baaki_require_committed_object(
  p_logical_bucket text,
  p_path           text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.storage_objects
     WHERE logical_bucket = p_logical_bucket
       AND path = p_path
       AND NOT pending
  ) THEN
    RAISE EXCEPTION 'OBJECT_NOT_COMMITTED: no uploaded image backs this path'
      USING ERRCODE = 'check_violation',
            HINT = 'Upload the image (put + commit) before recording its metadata.';
  END IF;
END
$$;

-- Supabase's default privileges grant EXECUTE on every new public function to
-- anon + authenticated DIRECTLY (see 20260806200000), so a bare
-- `REVOKE ... FROM public` would leave clients able to call this and use it as
-- an existence oracle over the service-role-only `storage_objects` ledger. Revoke
-- from the client roles explicitly; only the definer RPCs (and service_role) call it.
REVOKE ALL ON FUNCTION public.baaki_require_committed_object(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_require_committed_object(text, text) TO service_role;

-- ─────────────────────────────── attach a receipt attachment ──
-- Re-declared whole from 20260825130000 (the cap + audit version), with the
-- committed-object guard added just after the replay short-circuit: a replay
-- returns the row already validated at its first attach, so only a genuinely new
-- key is checked, and it is checked before the cap so a phantom path is refused
-- cheaply.

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

  -- The bytes must really exist: a committed object at this key, in the
  -- attachments bucket. Blocks a phantom / never-uploaded / pending-only path
  -- from being recorded as an attachment. Checked for a genuinely new row only.
  PERFORM public.baaki_require_committed_object('expense-attachments', btrim(p_storage_path));

  -- Serialize the count-then-insert against other attaches to THIS expense: a
  -- transaction-scoped advisory lock keyed on the expense id. Without it two
  -- concurrent adds could both read a live count below the cap and both insert,
  -- landing one over (the same race the ghost-merge path guards). Only other
  -- attach calls take this key, so it never blocks unrelated writers, and it is
  -- released at commit. Taken before the count so a paid group pays only a
  -- trivial, uncontended lock and nothing else.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_expense_id::text, 0));

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

-- ─────────────────────────────── attach a settlement proof ──
-- Re-declared whole from 20260824150000, with the committed-object guard added
-- after the replay short-circuit (before the one-live-proof check), so a proof
-- can never point at bytes that were not uploaded.

CREATE OR REPLACE FUNCTION public.baaki_attach_settlement_proof(
  p_settlement_id uuid,
  p_storage_path  text,
  p_proof_id      uuid DEFAULT NULL
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
    RAISE EXCEPTION 'INVALID_PATH: a proof needs a stored image' USING ERRCODE = 'check_violation';
  END IF;

  -- The object key MUST be scoped to this subject: `<settlementId>/…`. This is
  -- the canonical contract the client and r2-sign both hold, and it stops a party
  -- to one settlement recording a path under another's prefix.
  IF p_storage_path NOT LIKE p_settlement_id::text || '/%' THEN
    RAISE EXCEPTION 'INVALID_PATH: the key must be scoped to its settlement'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Authorise BEFORE resolving the client-supplied id. Resolving first would let
  -- a non-party who guesses an existing id short-circuit to a success (an
  -- existence oracle), and skip the party check entirely.
  SELECT group_id INTO v_group_id FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.baaki_is_settlement_party(p_settlement_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only the payer or payee may attach a proof'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Replay: the SAME id for the SAME settlement returns the existing row. Bound
  -- to the subject so a reused id against a different settlement cannot pass.
  IF p_proof_id IS NOT NULL THEN
    SELECT id INTO v_id
    FROM public.settlement_proofs
    WHERE id = p_proof_id AND settlement_id = p_settlement_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  -- The bytes must really exist: a committed object at this key, in the
  -- settlement-proofs bucket. Blocks a phantom / never-uploaded / pending-only
  -- path. Checked for a genuinely new row only (a replay returned above).
  PERFORM public.baaki_require_committed_object('settlement-proofs', btrim(p_storage_path));

  -- One live proof per settlement. A replay reuses the same id (caught above);
  -- a genuine second attach must remove the first — a proof is immutable.
  IF EXISTS (
    SELECT 1 FROM public.settlement_proofs
    WHERE settlement_id = p_settlement_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PROOF_EXISTS: this settlement already has a proof; remove it first'
      USING ERRCODE = 'unique_violation';
  END IF;

  v_member := public.baaki_my_member_id(v_group_id);

  INSERT INTO public.settlement_proofs
    (id, settlement_id, group_id, uploader_member_id, storage_path)
  VALUES
    (COALESCE(p_proof_id, gen_random_uuid()), p_settlement_id, v_group_id, v_member,
     btrim(p_storage_path))
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_attach_settlement_proof(uuid, text, uuid)
  TO authenticated, anon;

-- ─────────────────────────────── repoint an attachment image ──
-- Re-declared whole from 20260825120000, with the committed-object guard added
-- after the party check: the new bytes (a rotate / crop written to a fresh key)
-- must have landed before the row is repointed at them.

CREATE OR REPLACE FUNCTION public.baaki_replace_expense_attachment_image(
  p_attachment_id uuid,
  p_new_path      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense_id uuid;
BEGIN
  IF coalesce(btrim(p_new_path), '') = '' THEN
    RAISE EXCEPTION 'INVALID_PATH: a replacement needs a stored image'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT expense_id INTO v_expense_id
  FROM public.expense_attachments
  WHERE id = p_attachment_id AND deleted_at IS NULL;
  IF v_expense_id IS NULL THEN
    RETURN;
  END IF;

  -- The new key MUST stay scoped to this expense, exactly like the attach RPC.
  IF p_new_path NOT LIKE v_expense_id::text || '/%' THEN
    RAISE EXCEPTION 'INVALID_PATH: the key must be scoped to its expense'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.baaki_is_expense_party(v_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may adjust this image'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The replacement bytes must really exist: a committed object at the new key.
  -- Without this the row could be repointed at a never-uploaded path, and the
  -- markup would be cleared, leaving the attachment pointing at nothing.
  PERFORM public.baaki_require_committed_object('expense-attachments', btrim(p_new_path));

  UPDATE public.expense_attachments
     SET storage_path = btrim(p_new_path),
         annotations  = NULL
   WHERE id = p_attachment_id AND deleted_at IS NULL;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_replace_expense_attachment_image(uuid, text)
  TO authenticated, anon;
