-- Personal finance (A48): a private, single-owner ledger — solo expenses and
-- income, recurring rules, loans, and monthly budgets. None of it is shared, has
-- members, or touches a group balance, so it does not go near the group expense
-- machinery. It rides the offline mirror on a personal scope (like captures and
-- the tag catalog): a per-owner `updated_seq`, owner-only RLS, soft delete.
--
-- One generic table holds all four record kinds. The server is only a relay for
-- this data — every summary, loan balance and budget figure is computed on the
-- device — so it never needs to read the shape of a record. Keeping it one table
-- (a `record_kind` discriminator + a `data` json blob) keeps the sync surface
-- tiny: one scope, one cursor, one pull, two mutation kinds.

-- The per-owner cursor behind the `:personal` sync scope, stamped onto every
-- personal_records row by the trigger below (the personal mirror of the group
-- counter, exactly like captures_seq / category_tags_seq).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS personal_seq bigint DEFAULT 0 NOT NULL;

CREATE FUNCTION public.baaki_next_personal_seq(p_owner uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.profiles
     SET personal_seq = personal_seq + 1
   WHERE id = p_owner
   RETURNING personal_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;

CREATE FUNCTION public.baaki_stamp_personal_seq() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_seq := public.baaki_next_personal_seq(NEW.owner_user_id);
  RETURN NEW;
END
$$;

CREATE TABLE public.personal_records (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    -- One of: 'txn' (an expense or income line), 'recurring' (a rule that mints
    -- txns), 'loan' (a debt owed either way), 'budget' (a monthly category cap).
    -- The shape of `data` follows from this; the client validates it.
    record_kind text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(6) with time zone,
    CONSTRAINT personal_records_kind_known
      CHECK ((record_kind = ANY (ARRAY['txn'::text, 'recurring'::text, 'loan'::text, 'budget'::text])))
);

ALTER TABLE ONLY public.personal_records
    ADD CONSTRAINT personal_records_pkey PRIMARY KEY (id);

CREATE INDEX personal_records_owner_user_id_updated_seq_idx
    ON public.personal_records USING btree (owner_user_id, updated_seq);

ALTER TABLE ONLY public.personal_records
    ADD CONSTRAINT personal_records_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE TRIGGER personal_records_stamp_seq
    BEFORE INSERT OR UPDATE ON public.personal_records
    FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_personal_seq();

ALTER TABLE public.personal_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY personal_records_own ON public.personal_records
    TO authenticated
    USING ((owner_user_id = public.baaki_current_profile_id()))
    WITH CHECK ((owner_user_id = public.baaki_current_profile_id()));

-- No hard DELETE for authenticated: a delete is the `deleted_at` tombstone, set
-- through /sync as the caller, so the removal rides the pull to other devices.
GRANT SELECT,INSERT,UPDATE ON TABLE public.personal_records TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.personal_records TO service_role;

REVOKE ALL ON FUNCTION public.baaki_next_personal_seq(p_owner uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.baaki_next_personal_seq(p_owner uuid) TO authenticated;
GRANT ALL ON FUNCTION public.baaki_next_personal_seq(p_owner uuid) TO service_role;

GRANT ALL ON FUNCTION public.baaki_stamp_personal_seq() TO anon;
GRANT ALL ON FUNCTION public.baaki_stamp_personal_seq() TO authenticated;
GRANT ALL ON FUNCTION public.baaki_stamp_personal_seq() TO service_role;
