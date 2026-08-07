-- TRUNCATE, which row-level security does not govern.
--
-- Found while verifying the previous migration, and worse than anything it
-- fixed.
--
-- Supabase's default `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,
-- authenticated` includes TRUNCATE, and **RLS does not apply to TRUNCATE**. It
-- is not a filtered DELETE; it is a table-level operation gated by the
-- privilege alone. Every policy in this schema is irrelevant to it.
--
-- Demonstrated on a scratch table carrying the same grant and a policy denying
-- every client every row: the client read zero rows out of it, and then
-- emptied it.
--
-- Which means that on the deployed project, anybody who signed in — and
-- `signInAnonymously()` means anybody at all, with no invitation and no email
-- — could have run
--
--   TRUNCATE public.group_members CASCADE;
--
-- and taken every group, every membership and every balance in the database
-- with it, without a single policy being consulted.
--
-- Nothing in this app truncates anything, and nothing ever should: the ledger
-- is append-only by design (ADR-004), expenses are soft-deleted, and somebody
-- leaving a group is `left_at`, not a missing row.

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Clients delete exactly one thing in this product — a receipt item claim they
-- made themselves, which is the only DELETE policy in the schema. Every other
-- table's DELETE was already refused by RLS for want of a policy; taking the
-- privilege away too means that refusal no longer depends on nobody ever
-- writing a permissive policy by accident.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT DELETE ON public.receipt_item_claims TO anon, authenticated;

-- A table added by a later migration arrives with the default grants again,
-- TRUNCATE included. That is not something to remember; it is something to
-- check. `packages/db/test/security-hardening.test.ts` walks every table in
-- `public` and fails the build if any of them is truncatable by a client.
