-- Two more rails: PayID and PayPal.
--
-- The CHECK constraints added in `20260807110000_payment_rails_and_country`
-- name every rail by hand, deliberately — a constraint rather than an enum, so
-- that adding a country is one migration and no type surgery. This is that
-- migration, and it is the whole cost of opening three markets at the database
-- level.
--
--   * **PayID** — Australia's instant rail over the NPP. Without it an
--     Australian group fell straight through to bank and cash, because
--     `railsFor('AU')` had nothing national to offer.
--   * **PayPal** — everywhere. It is the one link somebody in Sydney can send
--     somebody in Chennai, which is the case Wise and Revolut only half cover.
--
-- Nothing else moves: no column, no default, no backfill. A settlement already
-- recorded keeps the rail it was recorded with.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_payment_rail_known;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_payment_rail_known CHECK (
    payment_rail IS NULL OR payment_rail IN (
      'upi','pix','paynow','promptpay','qris','aani','payid',
      'zelle','venmo','cashapp','interac','wise','revolut','paypal',
      'bank','cash','other'
    )
  );

ALTER TABLE public.group_members
  DROP CONSTRAINT IF EXISTS group_members_payment_rail_known;
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_payment_rail_known CHECK (
    payment_rail IS NULL OR payment_rail IN (
      'upi','pix','paynow','promptpay','qris','aani','payid',
      'zelle','venmo','cashapp','interac','wise','revolut','paypal',
      'bank','cash','other'
    )
  );

ALTER TABLE public.settlements
  DROP CONSTRAINT IF EXISTS settlements_rail_known;
ALTER TABLE public.settlements
  ADD CONSTRAINT settlements_rail_known CHECK (
    rail IS NULL OR rail IN (
      'upi','pix','paynow','promptpay','qris','aani','payid',
      'zelle','venmo','cashapp','interac','wise','revolut','paypal',
      'bank','cash','other'
    )
  );
