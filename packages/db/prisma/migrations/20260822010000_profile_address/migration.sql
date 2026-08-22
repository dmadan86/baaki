-- An optional postal address on the profile.
--
-- "Your account" now asks for a country (which decides the default currency and
-- settle rails) and, optionally, a postal address. The country already had a
-- column (`profiles.country_code`); the address is new. One free-text field,
-- deliberately unstructured: address formats differ by country and Waves never
-- posts anything to it, so there is nothing here that needs parsing into lines.
--
-- Nullable with no default: an existing profile simply has no address until its
-- owner types one, and clearing the field stores NULL rather than an empty
-- string. No RLS change — a profile's own row is already self-updatable under
-- the policy that governs `display_name` and `country_code`.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS address text;
