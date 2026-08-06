-- What the app is allowed to be running.
--
-- One row per store. `latest_version` is what is published; `minimum_version`
-- is the oldest build still allowed to open. Both are here rather than in the
-- app because the whole point is to reach a build that has already shipped:
-- a version number compiled into the binary can only ever describe itself.
--
-- Three deliberate constraints, because a bad row in this table is the one
-- piece of data in the system that can lock every phone out of its own ledger:
--
--   1. Versions must be dotted numbers. A row saying `v2` or `2.0-rc` would
--      compare as unknown, and the client is written to let unknown through —
--      so a typo here fails open rather than closed, but it also silently
--      turns the policy off. Rejecting it at write time is better.
--   2. `minimum_version` may not exceed `latest_version`. That combination
--      blocks every build in existence, including the one the update button
--      would send somebody to install. There is no situation where it is
--      what was meant.
--   3. `store_url` is required. A wall with no way past it is worse than no
--      wall, so a forced update cannot be configured without the way out.
--
-- Readable by everybody including signed-out guests: the check has to run
-- before sign-in, since a client too old to be trusted is too old to sync.
-- Writable by nobody — there are no INSERT/UPDATE/DELETE policies at all, so
-- only the service role can change it (ADR-013).

CREATE OR REPLACE FUNCTION public.baaki_version_key(p_version text)
RETURNS int[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  -- Padded to four segments so `1.2` and `1.2.0.0` compare equal, matching
  -- `compareVersions` in @baaki/core. Postgres compares int[] element-wise.
  SELECT (string_to_array(p_version, '.') || ARRAY['0', '0', '0', '0'])[1:4]::int[]
$$;

COMMENT ON FUNCTION public.baaki_version_key(text) IS
  'Dotted version as a comparable int[]. Mirrors compareVersions in @baaki/core.';

CREATE TABLE public.app_releases (
  platform         text        PRIMARY KEY CHECK (platform IN ('ios', 'android')),
  latest_version   text        NOT NULL CHECK (latest_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  minimum_version  text        NOT NULL CHECK (minimum_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  store_url        text        NOT NULL CHECK (length(store_url) > 0),
  -- Optional: shown instead of the default copy, for when the reason matters
  -- ("expenses added on this version were splitting rupees wrongly").
  message          text,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_releases_minimum_not_above_latest
    CHECK (public.baaki_version_key(minimum_version) <= public.baaki_version_key(latest_version))
);

COMMENT ON TABLE public.app_releases IS
  'Per-store version policy. Public read, service-role write.';

ALTER TABLE public.app_releases ENABLE ROW LEVEL SECURITY;

-- Signed out on purpose: the version gate runs before the sign-in screen.
CREATE POLICY "app_releases are readable by everyone"
  ON public.app_releases
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Seed both stores at the version that exists today, so switching this on
-- changes nothing until somebody deliberately raises a number.
INSERT INTO public.app_releases (platform, latest_version, minimum_version, store_url)
VALUES
  ('android', '0.1.0', '0.1.0', 'https://play.google.com/store/apps/details?id=app.baaki.mobile'),
  ('ios',     '0.1.0', '0.1.0', 'https://apps.apple.com/app/baaki/id0000000000')
ON CONFLICT (platform) DO NOTHING;
