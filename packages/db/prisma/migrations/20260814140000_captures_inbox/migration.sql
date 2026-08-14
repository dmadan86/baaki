-- Captures — an expense caught before it has a group (TDR A34).
--
-- The complaint this answers: you pay for something now, but which group it
-- belongs to is not a decision you can make at the till — the friends are not
-- all in one Baaki group yet, or you do not know who was in on it. Today the
-- only way to record an expense is inside a group, so the choice is "decide the
-- group now or lose the amount". A capture is the third option: record what it
-- cost, keep the receipt, decide the group later.
--
-- It is deliberately NOT an `expenses` row. That table is group-scoped
-- (`group_id NOT NULL`, membership RLS, a per-group cursor) and every balance,
-- export and simplification reads it — a group-less row there would be wrong in
-- all of them. A capture carries no members and no split; it is personal until
-- it is assigned, at which point it becomes an ordinary expense in the chosen
-- group and this row is marked `assigned`, which is what removes it from the
-- inbox.
--
-- Personal, so it syncs under the OWNER rather than any group. The offline
-- queue and the `/sync` function key everything by a scope string that is
-- normally a group id; for a capture that scope is the owner's own user id, and
-- the server authorises by ownership (`owner_user_id = auth.uid()`) instead of
-- group membership. The per-owner monotonic `updated_seq` below is the personal
-- equivalent of `baaki_next_group_seq`, so a second device pulls its captures
-- with the same "everything since cursor N" the group tables use.

-- ─────────────────────────────────────────────── the per-owner counter ──
-- The monotonic sequence lives on the owner's `profiles` row, exactly as the
-- group counter lives on `groups`. Taking it with UPDATE … RETURNING holds a
-- row lock on that profile until commit, so within one owner the sequence order
-- is the commit order — the invariant the sync pull depends on.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS captures_seq BIGINT NOT NULL DEFAULT 0;

-- ────────────────────────────────────────────────────────── the table ──
CREATE TABLE public.captures (
  id                  UUID PRIMARY KEY,
  owner_user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE ON UPDATE CASCADE,
  description         TEXT NOT NULL DEFAULT '',
  category            TEXT,
  expense_date        DATE NOT NULL,
  currency            TEXT NOT NULL,
  -- Minor units, like every other amount here. NEVER a float (TDR binding rule).
  amount              BIGINT NOT NULL,
  notes               TEXT,
  -- Object path in the private `captures` storage bucket, read via a signed URL.
  photo_path          TEXT,
  -- On-device OCR text (A5), kept so assignment can prefill the expense form
  -- without re-scanning.
  raw_text            TEXT,
  parsed              JSONB,
  -- 'open' while in the inbox, 'assigned' once it became a real expense.
  status              TEXT NOT NULL DEFAULT 'open',
  -- Where it went, once assigned. Advisory pointers for navigation, not FKs:
  -- the target lives in a different (group) scope and a capture should not be
  -- deleted or blocked by anything happening there.
  assigned_expense_id UUID,
  assigned_group_id   UUID,
  updated_seq         BIGINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Soft delete, so removing a capture on one device propagates to another
  -- through the same cursor rather than silently vanishing from only one.
  deleted_at          TIMESTAMPTZ(6),
  CONSTRAINT captures_status_check CHECK (status IN ('open', 'assigned')),
  CONSTRAINT captures_amount_nonneg CHECK (amount >= 0)
);

-- "Everything since seq N for this owner", cheap — the personal mirror of
-- `expenses_group_id_updated_seq_idx`.
CREATE INDEX captures_owner_user_id_updated_seq_idx
  ON public.captures (owner_user_id, updated_seq);

-- ─────────────────────────────────────── the per-owner seq mechanism ──
CREATE OR REPLACE FUNCTION public.baaki_next_capture_seq(p_owner uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.profiles
     SET captures_seq = captures_seq + 1
   WHERE id = p_owner
   RETURNING captures_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;

CREATE OR REPLACE FUNCTION public.baaki_stamp_capture_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_seq := public.baaki_next_capture_seq(NEW.owner_user_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER captures_stamp_seq
  BEFORE INSERT OR UPDATE ON public.captures
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_capture_seq();

-- ─────────────────────────────────────────────────────────────── RLS ──
-- Owner-only, on every command — a capture has no co-viewers, unlike an
-- expense. `baaki_current_profile_id()` is the SQL-side `auth.uid()`. The
-- `/sync` function writes these rows AS THE CALLER, so this policy is the whole
-- gate; it never runs as the service role.
ALTER TABLE public.captures ENABLE ROW LEVEL SECURITY;

CREATE POLICY captures_own ON public.captures
  FOR ALL TO authenticated
  USING (owner_user_id = public.baaki_current_profile_id())
  WITH CHECK (owner_user_id = public.baaki_current_profile_id());

-- Supabase grants ALL on public to authenticated by default; be explicit and
-- narrow instead. Rows are read on pull and written on create/update/assign;
-- delete is soft (an UPDATE of deleted_at), so no DELETE is needed.
REVOKE ALL ON public.captures FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.captures TO authenticated;

-- ─────────────────────────────────────────────── the receipt's photo ──
-- A private bucket like the others (ADR-013). A capture's photo has exactly one
-- viewer — its owner — so every policy is owner-only, including SELECT (an
-- avatar is shared with groupmates; a personal receipt is not). The path is
-- `<ownerUserId>/<captureId>.<ext>`, and `baaki_group_from_storage_path` parses
-- that first segment as a uuid — a malformed path denies rather than raising.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the captures bucket';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('captures', 'captures', false, 5242880,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "captures are readable by their owner" ON storage.objects;
    CREATE POLICY "captures are readable by their owner" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'captures'
        AND public.baaki_group_from_storage_path(name) = public.baaki_current_profile_id()
      );

    DROP POLICY IF EXISTS "captures are writable by their owner" ON storage.objects;
    CREATE POLICY "captures are writable by their owner" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'captures'
        AND public.baaki_group_from_storage_path(name) = public.baaki_current_profile_id()
      );

    DROP POLICY IF EXISTS "captures are replaceable by their owner" ON storage.objects;
    CREATE POLICY "captures are replaceable by their owner" ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'captures'
        AND public.baaki_group_from_storage_path(name) = public.baaki_current_profile_id()
      );

    DROP POLICY IF EXISTS "captures are removable by their owner" ON storage.objects;
    CREATE POLICY "captures are removable by their owner" ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'captures'
        AND public.baaki_group_from_storage_path(name) = public.baaki_current_profile_id()
      );
  $policy$;
END
$$;
