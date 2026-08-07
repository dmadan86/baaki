-- A country, and the rail money moves on in it.
--
-- The schema said UPI in three places without saying "UPI": `settlements.method`
-- is an enum whose interesting value is `upi`, and the handle a person is paid
-- at is called `vpa` — a UPI ID — on both `profiles` and `group_members`. That
-- is honest for one market and wrong for the next one, where the same field
-- holds a Pix key, an IBAN or a phone number.
--
-- Three additions, no removals:
--
--   * **`country_code`** on `profiles` and `groups`. A group is where it
--     settles, not where its members live — a Goa trip run from Dubai settles
--     in rupees over UPI, and the group is the thing that knows that. Nullable,
--     because a group that never says stays exactly as it is today.
--   * **`payment_rail` + `payment_handle`** alongside the `vpa` columns, and
--     backfilled from them. A handle without the rail it belongs to is
--     unusable outside India: `+971 50 123 4567` is an Aani number, a PayNow
--     number or a Zelle number, and only the rail says which.
--   * **`settlements.rail`** — which rail was actually used, backfilled from
--     `method`. `method` stays: it is on every existing row, the app reads it,
--     and an enum is a poor place to add fifteen values (`ALTER TYPE ... ADD
--     VALUE` does not compose with a migration that runs in a transaction).
--     `rail` is the truth going forward; `method` is the coarse legacy shape.
--
-- `vpa` and `default_vpa` are left in place and left alone. They are read by
-- five screens, and a rename is a change to all of them plus every RPC that
-- touches one — worth doing, not worth doing in the same change as the thing
-- that makes the rename meaningful.

-- ───────────────────────────────────────────────────── where people are ──

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS country_code char(2),
  ADD COLUMN IF NOT EXISTS payment_rail text,
  ADD COLUMN IF NOT EXISTS payment_handle text;

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS country_code char(2);

ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS payment_rail text,
  ADD COLUMN IF NOT EXISTS payment_handle text;

ALTER TABLE public.settlements
  ADD COLUMN IF NOT EXISTS rail text;

-- ─────────────────────────────────────────────── what a rail may be ──
--
-- Kept in step with `RailId` in `packages/core/src/settlement/rails.ts`. A
-- constraint rather than an enum so that adding Brazil is one migration and no
-- type surgery — the reason `method` is not being extended.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_payment_rail_known;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_payment_rail_known CHECK (
    payment_rail IS NULL OR payment_rail IN (
      'upi','pix','paynow','promptpay','qris','aani',
      'zelle','venmo','cashapp','interac','wise','revolut',
      'bank','cash','other'
    )
  );

ALTER TABLE public.group_members
  DROP CONSTRAINT IF EXISTS group_members_payment_rail_known;
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_payment_rail_known CHECK (
    payment_rail IS NULL OR payment_rail IN (
      'upi','pix','paynow','promptpay','qris','aani',
      'zelle','venmo','cashapp','interac','wise','revolut',
      'bank','cash','other'
    )
  );

ALTER TABLE public.settlements
  DROP CONSTRAINT IF EXISTS settlements_rail_known;
ALTER TABLE public.settlements
  ADD CONSTRAINT settlements_rail_known CHECK (
    rail IS NULL OR rail IN (
      'upi','pix','paynow','promptpay','qris','aani',
      'zelle','venmo','cashapp','interac','wise','revolut',
      'bank','cash','other'
    )
  );

-- ────────────────────────────────────────────────────────── backfill ──
--
-- Everything already in this database is Indian, and every handle in it is a
-- UPI ID, because until now there was nothing else it could be.

UPDATE public.profiles
   SET payment_rail = 'upi', payment_handle = default_vpa
 WHERE default_vpa IS NOT NULL AND payment_handle IS NULL;

UPDATE public.group_members
   SET payment_rail = 'upi', payment_handle = vpa
 WHERE vpa IS NOT NULL AND payment_handle IS NULL;

-- `method` and `rail` share their four historical values exactly, so this is a
-- copy rather than a mapping.
UPDATE public.settlements
   SET rail = method::text
 WHERE rail IS NULL;

-- Existing groups are Indian groups. A group created from here on gets its
-- country from whoever created it, and a group with no country still works —
-- `railsFor(null)` returns bank, cash and the cross-border wallets.
UPDATE public.groups SET country_code = 'IN' WHERE country_code IS NULL;
UPDATE public.profiles SET country_code = 'IN' WHERE country_code IS NULL;

-- ──────────────────────────────────── recording which rail was used ──
--
-- One function, not two: the old nine-argument signature is dropped rather
-- than left beside a ten-argument one, because two functions that differ by a
-- default are two functions to keep in step. Every caller passes named
-- parameters (`p_group_id => ...`), so a new parameter with a default is
-- invisible to all of them.

DROP FUNCTION IF EXISTS public.baaki_record_settlement(
  uuid, uuid, uuid, bigint, text, character, text, jsonb, uuid
);

-- The body below is the M1 function unchanged, with `rail` added. Nothing else
-- about it moves: the currency still falls back to the group's, the client
-- mutation id is still stored (without it a retried settlement pays somebody
-- twice, ADR-005), allocations still accumulate on conflict, and the activity
-- entry is still written.

CREATE OR REPLACE FUNCTION public.baaki_record_settlement(
  p_group_id           uuid,
  p_from_member_id     uuid,
  p_to_member_id       uuid,
  p_amount             bigint,
  p_method             text,
  p_currency           char(3) DEFAULT NULL,
  p_note               text DEFAULT NULL,
  p_allocations        jsonb DEFAULT '[]'::jsonb,
  p_client_mutation_id uuid DEFAULT NULL,
  /** Which rail, specifically. Falls back to `p_method` for older clients. */
  p_rail               text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settlement_id uuid;
  v_currency      char(3);
  v_actor         uuid;
  v_allocation    jsonb;
  v_rail          text := COALESCE(NULLIF(btrim(p_rail), ''), p_method);
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in this group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: settle a positive amount' USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying the same mutation must not create a second settlement (ADR-005).
  IF p_client_mutation_id IS NOT NULL THEN
    SELECT id INTO v_settlement_id
    FROM public.settlements WHERE client_mutation_id = p_client_mutation_id;
    IF v_settlement_id IS NOT NULL THEN
      RETURN v_settlement_id;
    END IF;
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  INSERT INTO public.settlements
    (group_id, from_member_id, to_member_id, currency, amount, method, rail, status, note,
     client_mutation_id)
  VALUES
    (p_group_id, p_from_member_id, p_to_member_id, upper(v_currency), p_amount,
     -- A rail the old enum has never heard of still records as a settlement:
     -- it lands as `other` in the legacy column and as itself in `rail`.
     CASE WHEN p_method IN ('upi', 'cash', 'bank', 'other') THEN p_method ELSE 'other' END
       ::"SettlementMethod",
     v_rail, 'initiated', p_note, p_client_mutation_id)
  RETURNING id INTO v_settlement_id;

  FOR v_allocation IN SELECT * FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb))
  LOOP
    INSERT INTO public.settlement_allocations (settlement_id, expense_id, amount)
    VALUES (
      v_settlement_id,
      (v_allocation ->> 'expenseId')::uuid,
      (v_allocation ->> 'amount')::bigint
    )
    ON CONFLICT (settlement_id, expense_id)
    DO UPDATE SET amount = public.settlement_allocations.amount + EXCLUDED.amount;
  END LOOP;

  v_actor := public.baaki_my_member_id(p_group_id);
  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (p_group_id, v_actor, 'settled', 'settlement', v_settlement_id,
          jsonb_build_object('amount', p_amount, 'currency', v_currency,
                             'method', p_method, 'rail', v_rail));

  RETURN v_settlement_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_record_settlement(
  uuid, uuid, uuid, bigint, text, character, text, jsonb, uuid, text
) TO authenticated, anon;
