-- Private / party-only attachments (feature plan §3, security review
-- docs/private-attachments-security-review.md).
--
-- A new visibility tier below the group: `parties`. Some images in a shared trip
-- must be seen by fewer people than the whole group — a payment screenshot (the
-- payer + payee of a settlement) or a personal bill the payer does not want the
-- group to read (the expense's payers + author). ADR-006 says "everything in a
-- group is visible to all members"; this is a narrow, RLS-enforced sub-group
-- boundary, the same shape `TripMemberBudget.visibility ∈ {private,group}`
-- already set for an owner-only row — extended here from "owner-only" to
-- "parties-only".
--
-- The load-bearing rule from the security review: **a restricted path must never
-- be a column on a group-visible row.** Postgres RLS is row-level, so a
-- `settlements.proof_path` column would ship the key to every member (the pull
-- returns whole rows, and a member can `GET /settlements?select=proof_path`
-- directly). So restricted paths live in their own rows, with a SELECT policy
-- that embeds the party predicate — a non-party's read returns zero rows.
--
-- Two thin tables rather than one polymorphic one, so each FK cascades cleanly
-- and each RLS predicate is unambiguous. Both ride the offline mirror like the
-- plan (updated_seq + baaki_stamp_seq + soft-delete tombstone); the bytes stay in
-- R2, brokered by r2-sign with a party check repeated at presign time and a
-- 60-second TTL for these buckets (a presigned R2 URL cannot be revoked).

-- ─────────────────────────────────────────────────── party predicates ──
--
-- SECURITY DEFINER so they can read settlements / expense_payers regardless of
-- the caller's own RLS, but they only ever answer about the CALLER's own
-- membership (`gm.profile_id = baaki_current_profile_id()`), so they leak
-- nothing — the same safe shape as `is_group_member`.

CREATE OR REPLACE FUNCTION public.baaki_is_settlement_party(p_settlement_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.settlements s
    JOIN public.group_members gm
      ON gm.id IN (s.from_member_id, s.to_member_id)
    WHERE s.id = p_settlement_id
      AND gm.profile_id = public.baaki_current_profile_id()
      AND gm.left_at IS NULL
  )
$$;

-- A party to an expense is a payer of its current version, or the version's
-- author. An expense has no single "payee"; the payer set is the honest owner of
-- the bill.
CREATE OR REPLACE FUNCTION public.baaki_is_expense_party(p_expense_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.expenses e
    JOIN public.expense_versions v ON v.id = e.current_version_id
    LEFT JOIN public.expense_payers ep ON ep.expense_version_id = v.id
    JOIN public.group_members gm
      ON gm.id = ep.member_id OR gm.id = v.author_member_id
    WHERE e.id = p_expense_id
      AND gm.profile_id = public.baaki_current_profile_id()
      AND gm.left_at IS NULL
  )
$$;

REVOKE ALL ON FUNCTION public.baaki_is_settlement_party(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_is_settlement_party(uuid) TO authenticated, anon;
REVOKE ALL ON FUNCTION public.baaki_is_expense_party(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_is_expense_party(uuid) TO authenticated, anon;

-- ───────────────────────────────────────────────────────────── tables ──

CREATE TABLE IF NOT EXISTS public.settlement_proofs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id      uuid NOT NULL REFERENCES public.settlements(id) ON DELETE CASCADE ON UPDATE CASCADE,
  group_id           uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
  uploader_member_id uuid NOT NULL REFERENCES public.group_members(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- The R2 object key. Includes a random uuid segment so knowing the settlement
  -- id is not enough to craft it (security review threat (f)).
  storage_path       text NOT NULL,
  -- A proof is ALWAYS party-only; the column exists for symmetry with
  -- expense_attachments and to make the invariant explicit.
  visibility         text NOT NULL DEFAULT 'parties' CHECK (visibility = 'parties'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_seq        bigint NOT NULL DEFAULT 0,
  deleted_at         timestamptz,
  CONSTRAINT settlement_proofs_path_present CHECK (btrim(storage_path) <> '')
);

-- One live proof per settlement (v1) is enforced in the attach RPC below (a
-- partial unique index would not round-trip through the Prisma schema, so the
-- invariant lives in the writer, the only way in).
CREATE INDEX IF NOT EXISTS settlement_proofs_settlement_idx
  ON public.settlement_proofs (settlement_id);
CREATE INDEX IF NOT EXISTS settlement_proofs_group_id_updated_seq_idx
  ON public.settlement_proofs (group_id, updated_seq);

CREATE TABLE IF NOT EXISTS public.expense_attachments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id         uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  group_id           uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
  uploader_member_id uuid NOT NULL REFERENCES public.group_members(id) ON DELETE CASCADE ON UPDATE CASCADE,
  storage_path       text NOT NULL,
  visibility         text NOT NULL DEFAULT 'group' CHECK (visibility IN ('group', 'parties')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_seq        bigint NOT NULL DEFAULT 0,
  deleted_at         timestamptz,
  CONSTRAINT expense_attachments_path_present CHECK (btrim(storage_path) <> '')
);

CREATE INDEX IF NOT EXISTS expense_attachments_expense_idx
  ON public.expense_attachments (expense_id);
CREATE INDEX IF NOT EXISTS expense_attachments_group_id_updated_seq_idx
  ON public.expense_attachments (group_id, updated_seq);

DROP TRIGGER IF EXISTS settlement_proofs_stamp_seq ON public.settlement_proofs;
CREATE TRIGGER settlement_proofs_stamp_seq
  BEFORE INSERT OR UPDATE ON public.settlement_proofs
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

DROP TRIGGER IF EXISTS expense_attachments_stamp_seq ON public.expense_attachments;
CREATE TRIGGER expense_attachments_stamp_seq
  BEFORE INSERT OR UPDATE ON public.expense_attachments
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_seq();

ALTER TABLE public.settlement_proofs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_attachments ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────── RLS: reads ──
--
-- The party predicate is the outer gate. `is_group_member` is kept as an
-- explicit first conjunct so a member who has LEFT is denied immediately, even
-- though party-ship already implies live membership — defense in depth, and it
-- short-circuits before the heavier party join.

CREATE POLICY settlement_proofs_select ON public.settlement_proofs
  FOR SELECT TO authenticated, anon
  USING (
    public.is_group_member(group_id)
    AND public.baaki_is_settlement_party(settlement_id)
  );

CREATE POLICY expense_attachments_select ON public.expense_attachments
  FOR SELECT TO authenticated, anon
  USING (
    public.is_group_member(group_id)
    AND (visibility = 'group' OR public.baaki_is_expense_party(expense_id))
  );

-- No INSERT/UPDATE/DELETE policy and no privilege: the RPCs below are the only
-- way in, so `uploader_member_id` comes from the session (unforgeable) and the
-- party check cannot be skipped by a direct PostgREST write.
REVOKE ALL ON public.settlement_proofs   FROM anon, authenticated;
REVOKE ALL ON public.expense_attachments FROM anon, authenticated;
GRANT SELECT ON public.settlement_proofs   TO anon, authenticated;
GRANT SELECT ON public.expense_attachments TO anon, authenticated;

-- ──────────────────────────────────────────────────────── RLS: writes ──

/**
 * Attach a payment proof to a settlement. Only a party (payer or payee) may,
 * and `uploader_member_id` is the caller's own member id, never an argument —
 * "who attached this" is not a question a client answers about itself. The
 * bytes were already PUT to R2 (r2-sign, party-checked again there); this records
 * the pointer. Replaying returns the same row (ADR-005). A proof is immutable:
 * replacing one is remove + attach with a fresh, unguessable key.
 */
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

  IF p_proof_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.settlement_proofs WHERE id = p_proof_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT group_id INTO v_group_id FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.baaki_is_settlement_party(p_settlement_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only the payer or payee may attach a proof'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

/** Remove a settlement proof. A party (or the uploader) may; soft delete so the
 *  tombstone syncs, and twice is a no-op. */
CREATE OR REPLACE FUNCTION public.baaki_remove_settlement_proof(p_proof_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settlement_id uuid;
BEGIN
  SELECT settlement_id INTO v_settlement_id
  FROM public.settlement_proofs WHERE id = p_proof_id;
  IF v_settlement_id IS NULL THEN
    RETURN; -- Already gone.
  END IF;
  IF NOT public.baaki_is_settlement_party(v_settlement_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may remove a proof'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.settlement_proofs
     SET deleted_at = now()
   WHERE id = p_proof_id AND deleted_at IS NULL;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_remove_settlement_proof(uuid) TO authenticated, anon;

/**
 * Attach an image to an expense at a chosen visibility. Only a party (a payer of
 * the current version, or the author) may — even a `group`-visible attachment is
 * added by someone with a stake in the bill. `uploader_member_id` is the session's.
 */
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

  IF p_attachment_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.expense_attachments WHERE id = p_attachment_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.baaki_is_expense_party(p_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a payer or the author may attach to this expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_member := public.baaki_my_member_id(v_group_id);

  INSERT INTO public.expense_attachments
    (id, expense_id, group_id, uploader_member_id, storage_path, visibility)
  VALUES
    (COALESCE(p_attachment_id, gen_random_uuid()), p_expense_id, v_group_id, v_member,
     btrim(p_storage_path), p_visibility)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_attach_expense_attachment(uuid, text, text, uuid)
  TO authenticated, anon;

/** Remove an expense attachment. A party may; soft delete, twice is a no-op. */
CREATE OR REPLACE FUNCTION public.baaki_remove_expense_attachment(p_attachment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense_id uuid;
BEGIN
  SELECT expense_id INTO v_expense_id
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
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_remove_expense_attachment(uuid) TO authenticated, anon;
