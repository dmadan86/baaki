-- The two privileges the audit missed.
--
-- Supabase grants `ALL` on every table in `public` to `anon` and
-- `authenticated`. The security hardening migration went through that grant
-- verb by verb — SELECT, INSERT, UPDATE, DELETE, and later TRUNCATE, which RLS
-- does not govern — and left two behind because they read as harmless:
-- TRIGGER and REFERENCES. Twenty-three tables, ninety-two grants.
--
-- **TRIGGER is not harmless.** `CREATE TRIGGER` needs the TRIGGER privilege on
-- the table and EXECUTE on the function, and nothing else — in particular it
-- does not need CREATE on the schema, which `anon` and `authenticated` do not
-- have. So a signed-in member cannot write their own trigger function, but they
-- can attach one of Baaki's. Hanging the balance-maintenance trigger on
-- `expense_shares` a second time makes every share count twice, and the derived
-- balances stop matching the ledger they are derived from — which is the one
-- thing this app promises. The client-side recomputation would catch it and
-- say the balances disagree, which is the right failure and still a failure.
--
-- **REFERENCES is smaller and still wrong.** It lets somebody point a foreign
-- key at a table they can only read, which pins rows against deletion and
-- turns a constraint violation into a probe for which ids exist.
--
-- Neither is used by anything. Prisma runs migrations as the table owner, which
-- needs no grant, and every trigger in this schema is created by a migration.

REVOKE TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- And for the next table somebody adds. Default privileges apply to objects
-- created by the role that sets them, which is the role Prisma migrates as —
-- so a table created by a future migration starts without these too, rather
-- than waiting for the next audit.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;
