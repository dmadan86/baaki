-- Which countries the phone-number sign-in offers, turned from the admin console.
--
-- The app ships a fixed market set (`COUNTRIES` in @waves/core), but which of
-- those the dial-code picker actually offers is an operational decision — a
-- market we are not live in yet, or one we have paused — and it must change
-- without a deploy, like the receipt cap does. `app_config` cannot hold it (that
-- table answers "how many", one integer per key) and `feature_flags` answers
-- on/off/which-arm for a *rollout*, not a per-country list. So a small table of
-- its own, the same shape of trust as both: readable by any client, written by
-- the service role alone.
--
-- Denylist, not allowlist: a country is offered unless a row here says otherwise.
-- The absence of a row means "enabled", so a fresh project with an empty table
-- offers every market the app stocks — nothing disappears until an operator
-- deliberately turns it off, and a project the seed never reached is never
-- accidentally locked out of phone sign-in.

CREATE TABLE IF NOT EXISTS public.country_settings (
  -- ISO-3166 alpha-2, upper-case — the same key `COUNTRIES` and `countryFlag`
  -- use, so a lookup from either side needs no normalising.
  code       char(2) PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT country_settings_code_shape CHECK (code ~ '^[A-Z]{2}$')
);

ALTER TABLE public.country_settings ENABLE ROW LEVEL SECURITY;

-- Readable by everybody, guests and the signed-out included: the phone-entry
-- screen draws its picker before there is ever a session, and offline
-- (ADR-005). Nothing here is about a person, so a blanket read is right.
DROP POLICY IF EXISTS country_settings_read ON public.country_settings;
CREATE POLICY country_settings_read ON public.country_settings
  FOR SELECT TO anon, authenticated USING (true);

-- No write policy, so with RLS on only the service role changes the list. A set
-- of enabled markets a client could edit is not a control.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.country_settings FROM anon, authenticated;
