-- The trip's pinned exchange rates (A: currency-conversion tiers).
--
-- A rate paid in a currency the group does not settle in already rode on each
-- expense version, exact and reproducible (ADR-003). What was missing was a
-- place to set one *once*: a Vietnam trip meant re-typing the rate on every
-- bill. `groups.fx_rates` is that place — one admin-pinned rate per currency
-- paid in, converting to the group's own `default_currency`, shared by everyone
-- so the trip's totals and budgets are counted the same way. A person's own
-- card rate and a per-bill override live off the group (device-local, and on
-- `expense_versions.fx`); only this shared tier touches the database.
--
-- Same shape and same guardrails as `category_budgets`: a JSON map on the group
-- row, group-visible, and writable ONLY through a definer RPC that checks admin
-- — never by a direct column write.

ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS fx_rates jsonb;

-- ─────────────────────────────────────────────── the admin-only setter ──
--
-- One entry, keyed by the currency paid in (`p_from`); the `to` is always the
-- group's settle currency, so it is not stored. NULL num/den clears that
-- currency's entry. The rate is an exact rational (num/den), never a decimal —
-- the whole point of ADR-003 — so the client hands over the two integers it
-- already computed with `rateFromDecimal` / `rateFromAmounts`.

CREATE OR REPLACE FUNCTION public.baaki_set_group_fx_rate(
  p_group_id uuid,
  p_from character,
  p_num bigint DEFAULT NULL::bigint,
  p_den bigint DEFAULT NULL::bigint,
  p_source text DEFAULT 'manual'
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_default char(3);
  v_from    char(3);
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN: only an admin sets a trip rate'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_from := upper(p_from);

  SELECT default_currency INTO v_default FROM public.groups WHERE id = p_group_id;
  IF v_default IS NULL THEN
    RAISE EXCEPTION 'NO_SUCH_GROUP' USING ERRCODE = 'no_data_found';
  END IF;

  -- A group never converts its own settle currency: that "rate" is always 1 and
  -- storing it would only give the resolver a wrong-direction entry to trip on.
  IF v_from = v_default THEN
    RAISE EXCEPTION 'SAME_CURRENCY: a trip rate converts a foreign currency into %, not itself', v_default
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_num IS NULL OR p_den IS NULL THEN
    -- Clear this currency's entry, leaving an empty object rather than NULL so
    -- the column's type stays an object.
    UPDATE public.groups SET
      fx_rates   = COALESCE(fx_rates, '{}'::jsonb) - v_from,
      updated_at = now()
    WHERE id = p_group_id;
    RETURN;
  END IF;

  -- A rate is two positive integers; anything else is not a rate.
  IF p_num <= 0 OR p_den <= 0 THEN
    RAISE EXCEPTION 'INVALID_RATE: a rate is a ratio of two positive integers'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.groups SET
    fx_rates = jsonb_set(
      COALESCE(fx_rates, '{}'::jsonb),
      ARRAY[v_from],
      jsonb_build_object(
        'num', p_num::text,
        'den', p_den::text,
        'ts', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'source', COALESCE(NULLIF(btrim(p_source), ''), 'manual')
      ),
      true
    ),
    updated_at = now()
  WHERE id = p_group_id;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_set_group_fx_rate(uuid, character, bigint, bigint, text) FROM PUBLIC, anon;
GRANT  ALL ON FUNCTION public.baaki_set_group_fx_rate(uuid, character, bigint, bigint, text) TO authenticated, service_role;

-- ─────────────────────────────── shut the direct-write door on the column ──
--
-- The guard trigger already blocks a client writing category_budgets or the
-- join token straight onto the row. fx_rates joins them: it is set through the
-- RPC above, which checks admin, and nowhere else. Recreated in full (the
-- trigger keeps pointing at the same function) with the one new clause.

CREATE OR REPLACE FUNCTION public.baaki_guard_group_columns() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.updated_seq IS DISTINCT FROM OLD.updated_seq THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: updated_seq is set by the server, not the client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s creator is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s id is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s creation time is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.photo_path IS DISTINCT FROM OLD.photo_path
     AND NEW.photo_path IS NOT NULL
     AND NOT public.baaki_can_upload_group_photo(NEW.id) THEN
    RAISE EXCEPTION 'PHOTO_GATE: a group photo is a paid feature'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.category_budgets IS DISTINCT FROM OLD.category_budgets THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: category budgets are set through baaki_set_category_budget, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.fx_rates IS DISTINCT FROM OLD.fx_rates THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: trip rates are set through baaki_set_group_fx_rate, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.join_token IS DISTINCT FROM OLD.join_token THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: the join link is set through baaki_ensure_group_join_token / baaki_reset_group_join_token, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;
