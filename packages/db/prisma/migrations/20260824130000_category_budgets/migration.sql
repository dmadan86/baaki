-- Category budgets: a per-category cap for the trip — food, stays, transport,
-- activities — beside the overall ceiling and the personal ones.
--
-- Same reasoning as the overall budget (20260813120000_trip_budgets): the ledger
-- already holds what was spent, so this stores only the *targets* and the app
-- draws a bar by dividing the category's spend by its cap. And like the overall
-- budget — and unlike a personal budget — a category cap is a group signal, set
-- by an admin and seen by everyone. So it needs no privacy, no row-level gate,
-- and no table of its own: it lives on the already-group-visible group row as a
-- JSON map, and rides the same mirror the overall budget does.
--
--   category_budgets = { "<category>": { "amountMinor": "<minor>", "currency": "INR" }, ... }
--
-- The category key is a built-in category id or a custom tag id — the same key
-- the ledger's `category` column carries. `amountMinor` is a string, the shape
-- the mirror and client already use for minor units in JSON.

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS category_budgets jsonb;

-- The map must be an object when present. A malformed blob would break every
-- reader; the RPC below is the only writer, but the constraint is cheap insurance.
ALTER TABLE public.groups
  DROP CONSTRAINT IF EXISTS groups_category_budgets_object;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_category_budgets_object
  CHECK (category_budgets IS NULL OR jsonb_typeof(category_budgets) = 'object');

-- ────────────────────────────────────────────────────────────── writing ──

/**
 * Set (or clear) one category's cap. Admin only — a category ceiling is the
 * group's, the same as the overall budget, so letting any member move it would
 * make it nobody's. `p_amount_minor` NULL removes that category's key;
 * otherwise it is upserted into the JSON map. `p_currency` NULL takes the
 * group's default. Updating the row bumps `updated_seq` through the existing
 * groups trigger, so the change rides the mirror to every device.
 */
CREATE OR REPLACE FUNCTION public.baaki_set_category_budget(
  p_group_id     uuid,
  p_category     text,
  p_amount_minor bigint  DEFAULT NULL,
  p_currency     char(3) DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_currency char(3);
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN: only an admin sets a category budget'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'INVALID_CATEGORY: a category is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_amount_minor IS NOT NULL AND p_amount_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: a budget is zero or more'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  IF p_amount_minor IS NULL THEN
    -- Clear: drop the key, leaving an empty object rather than NULL so the
    -- column's type stays an object.
    UPDATE public.groups SET
      category_budgets = COALESCE(category_budgets, '{}'::jsonb) - p_category,
      updated_at       = now()
    WHERE id = p_group_id;
  ELSE
    UPDATE public.groups SET
      category_budgets = jsonb_set(
        COALESCE(category_budgets, '{}'::jsonb),
        ARRAY[p_category],
        jsonb_build_object(
          'amountMinor', p_amount_minor::text,
          'currency', upper(v_currency)
        ),
        true
      ),
      updated_at = now()
    WHERE id = p_group_id;
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_set_category_budget(uuid, text, bigint, character)
  TO authenticated, anon;

-- ──────────────────────────────────────────────────────── write boundary ──
--
-- `groups` still carries the broad row-scoped UPDATE policy, so a signed-in
-- client can `PATCH /groups?id=eq.<X>` under its own JWT and set any column the
-- column guard does not pin (20260815120000). Left open, a NON-admin member
-- could write `category_budgets` directly — bypassing the admin check in the
-- RPC above — and could store a malformed shape that breaks every reader's
-- `BigInt(amountMinor)`. Pin the column: a client may never write it. The only
-- writer is `baaki_set_category_budget`, SECURITY DEFINER, which runs as the
-- function owner and so clears the `current_user` gate below untouched.
--
-- Re-declared in full (CREATE OR REPLACE) from 20260815180000 so the existing
-- updated_seq / created_by / id / created_at / photo_path guards are preserved;
-- only the category_budgets block is added.
CREATE OR REPLACE FUNCTION public.baaki_guard_group_columns()
RETURNS trigger
LANGUAGE plpgsql
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

  -- A group photo is a paid feature (ADR-011 addendum). Only gate setting one;
  -- clearing it back to NULL is free and always allowed.
  IF NEW.photo_path IS DISTINCT FROM OLD.photo_path
     AND NEW.photo_path IS NOT NULL
     AND NOT public.baaki_can_upload_group_photo(NEW.id) THEN
    RAISE EXCEPTION 'PHOTO_GATE: a group photo is a paid feature'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Category caps are the group's, admin-set, and written only through
  -- `baaki_set_category_budget` (owner-run, exempt above). A signed-in client
  -- never writes this column directly — that is where the admin check and the
  -- shape live.
  IF NEW.category_budgets IS DISTINCT FROM OLD.category_budgets THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: category budgets are set through baaki_set_category_budget, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;
