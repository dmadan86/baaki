-- The trigger that gives a new account its profile row, put back.
--
-- `public.waves_handle_new_user()` mirrors an `auth.users` insert into
-- `public.profiles`. The function survived the 2026-09-04 squash into
-- `20260904000000_waves_baseline`; **the trigger did not**. The baseline was
-- built from a schema-only dump of a local plain Postgres, and a plain Postgres
-- has no `auth` schema at all — so a trigger that lives on `auth.users` could
-- never appear in it. This is the same loss that took the 19 `storage.objects`
-- policies, and for exactly the same reason.
--
-- What it cost: every account created on a rebuilt project since 2026-09-04 got
-- an `auth.users` row and no profile. The app reads `profiles` for the signed-in
-- person, so the dashboard fell back to initials for a name it did not have and
-- the settings tab — which holds a skeleton until the profile arrives — never
-- stopped loading.
--
-- Two halves, both idempotent: re-create the trigger, then backfill the accounts
-- that were created while it was missing.

-- ─────────────────────────────────────────────── 1. the trigger, back ──
--
-- Guarded on `auth.users` existing, like the original: CI and the local drift
-- check run these migrations against a bare Postgres that has no `auth` schema,
-- where this is correctly a no-op.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE NOTICE 'no auth.users (bare Postgres) — new-user trigger skipped';
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS waves_on_auth_user_created ON auth.users;
  -- The pre-rebrand name, in case a database still carries it.
  DROP TRIGGER IF EXISTS baaki_on_auth_user_created ON auth.users;

  CREATE TRIGGER waves_on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.waves_handle_new_user();
END
$$;

-- ────────────────────────────────── 2. the accounts that missed out ──
--
-- Same COALESCE ladder the trigger uses, so a backfilled row is indistinguishable
-- from a triggered one. `ON CONFLICT DO NOTHING` keeps it a no-op on a database
-- that never lost the trigger.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN RETURN; END IF;

  INSERT INTO public.profiles (id, display_name, avatar_url, locale)
  SELECT
    u.id,
    COALESCE(
      NULLIF(u.raw_user_meta_data ->> 'display_name', ''),
      NULLIF(u.raw_user_meta_data ->> 'full_name', ''),
      NULLIF(u.raw_user_meta_data ->> 'name', ''),
      -- ADR-006: anonymous guests get an account too, just an unnamed one.
      'Guest'
    ),
    COALESCE(
      NULLIF(u.raw_user_meta_data ->> 'avatar_url', ''),
      NULLIF(u.raw_user_meta_data ->> 'picture', '')
    ),
    COALESCE(NULLIF(u.raw_user_meta_data ->> 'locale', ''), 'en')
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE p.id IS NULL
  ON CONFLICT (id) DO NOTHING;
END
$$;
