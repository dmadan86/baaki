-- Reload PostgREST's schema cache.
--
-- The rate-limit tables (20260809040000_rate_limit_controls) were deployed, but
-- the admin /rate-limits page kept reporting them missing. PostgREST caches the
-- database schema when it boots and only refreshes when told to, and nothing
-- told it. A read of a table it has not cached comes back PGRST205 — the very
-- same code as a table that genuinely is not there — so the page could not tell
-- "not deployed" from "not reloaded", and guessed the first (see TABLE_MISSING
-- in apps/admin/src/lib/data.ts).
--
-- NOTIFY on the `pgrst` channel is the signal PostgREST listens for. It fires on
-- commit; with no listener — CI's bare Postgres, or any database without
-- PostgREST attached — it is a harmless no-op, so this is safe to run anywhere.
--
-- Going forward, any migration that adds a table, view or function the API
-- serves should end with this same line, so a deploy never leaves the cache a
-- step behind what the schema now holds.

NOTIFY pgrst, 'reload schema';
