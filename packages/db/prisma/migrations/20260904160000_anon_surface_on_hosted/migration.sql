-- The signed-out surface, on a database that was not built from nothing.
--
-- Supabase ships default privileges on `public` that grant `anon` and
-- `authenticated` as each object is created. A plain Postgres has no such
-- thing, so the baseline — a dump of exactly that — carries the intended ACLs
-- and comes out right on CI and on a laptop. On a hosted project those defaults
-- are still in force while the baseline runs, and every table and function it
-- creates picks up a grant the dump never asked for.
--
-- The Mumbai project brought this up: 58 tables reachable by `anon` instead of
-- 3, and **132 SECURITY DEFINER functions executable by `anon` instead of 5**.
-- Definer functions run as their owner and are not bounded by RLS, so that
-- second number is the one that matters. The Singapore project did not show it
-- only because rebuilding it dropped the schema, and dropping a schema takes
-- its default-privilege entries with it.
--
-- This converges any database to the state the baseline describes, and is
-- idempotent: where the grants are already right it revokes and re-grants the
-- same thing. Run on CI it is a no-op that the anon-surface test then proves.
--
-- The house rule this encodes, from the original hardening pass: a revoke
-- `FROM PUBLIC` does not touch a direct grant, so anything meant to be
-- signed-in only needs `FROM PUBLIC, anon` — or, as here, the default
-- privilege itself has to stop handing it out.

-- ────────────────────────────── 1. stop it happening to the next object ──
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ─────────────────────────────────── 2. take back what it already gave ──
--
-- `authenticated` too: the baseline names 47 tables and a hosted rebuild had
-- all 58, including Prisma's own migration ledger.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ───────────────────────────────── 3. put back exactly what the baseline says ──
--
-- The three tables that have to answer before there is a session: what the
-- minimum supported version is, whether this country is open, and which flags
-- are on.
GRANT SELECT ON TABLE public.app_releases TO anon;
GRANT SELECT ON TABLE public.country_settings TO anon;
GRANT SELECT ON TABLE public.feature_flags TO anon;

-- The helpers the RLS policies themselves call. A policy written
-- `TO anon, authenticated` has to evaluate for either role, and for a
-- signed-out caller these answer "no" — which is the point.
GRANT EXECUTE ON FUNCTION public.is_group_member(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.waves_my_member_id(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.waves_is_expense_party(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.waves_is_settlement_party(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.waves_version_group_id(uuid) TO anon;

-- Everything a signed-in caller reads or writes directly. Replayed from the
-- baseline verbatim rather than restated, so the two cannot drift.
GRANT SELECT ON TABLE public.activity_log TO authenticated;
GRANT SELECT ON TABLE public.app_config TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.app_releases TO authenticated;
GRANT SELECT ON TABLE public.campaign_impressions TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.captures TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.category_tags TO authenticated;
GRANT SELECT ON TABLE public.country_settings TO authenticated;
GRANT SELECT ON TABLE public.device_sessions TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.email_events TO authenticated;
GRANT SELECT ON TABLE public.expense_attachments TO authenticated;
GRANT SELECT ON TABLE public.expense_comments TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.expense_disputes TO authenticated;
GRANT SELECT ON TABLE public.expense_image_events TO authenticated;
GRANT SELECT ON TABLE public.expense_payers TO authenticated;
GRANT SELECT ON TABLE public.expense_shares TO authenticated;
GRANT SELECT ON TABLE public.expense_versions TO authenticated;
GRANT SELECT ON TABLE public.expenses TO authenticated;
GRANT SELECT ON TABLE public.feature_flags TO authenticated;
GRANT SELECT ON TABLE public.feedback TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ghost_merges TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.group_balances TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.group_members TO authenticated;
GRANT SELECT ON TABLE public.group_passes TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.groups TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.invites TO authenticated;
GRANT SELECT ON TABLE public.member_claims TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.notifications TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.pairwise_balances TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.personal_records TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT ON TABLE public.promo_redemptions TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.push_tokens TO authenticated;
GRANT SELECT ON TABLE public.receipt_item_claims TO authenticated;
GRANT SELECT ON TABLE public.receipts TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.reminders TO authenticated;
GRANT SELECT ON TABLE public.service_config TO authenticated;
GRANT SELECT ON TABLE public.settlement_allocations TO authenticated;
GRANT SELECT ON TABLE public.settlement_proofs TO authenticated;
GRANT SELECT ON TABLE public.settlements TO authenticated;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.sync_mutations TO authenticated;
GRANT SELECT ON TABLE public.trip_member_budgets TO authenticated;
GRANT SELECT ON TABLE public.trip_photos TO authenticated;
GRANT SELECT ON TABLE public.trip_plan_items TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.usage_events TO authenticated;
GRANT INSERT ON TABLE public.voice_attempts TO authenticated;
GRANT SELECT ON TABLE public.voice_stt_usage TO authenticated;

-- ──────────────────────────────────── 4. Prisma's ledger is Prisma's alone ──
--
-- `_prisma_migrations` is created by Prisma before any migration runs, so the
-- baseline never describes it and the default privileges reached it unopposed.
-- The revoke above already took the grants; RLS is the second lock, and the
-- table owner is exempt without `FORCE`, so Prisma keeps writing to it.
ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────── 5. the guard ──
DO $guard$
DECLARE
  reachable int;
  definers  int;
BEGIN
  SELECT count(DISTINCT table_name) INTO reachable
    FROM information_schema.role_table_grants
   WHERE grantee = 'anon' AND table_schema = 'public';
  SELECT count(*) INTO definers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF reachable <> 3 OR definers <> 5 THEN
    RAISE EXCEPTION
      'signed-out surface is wrong: % tables (want 3), % definer functions (want 5)',
      reachable, definers;
  END IF;
END
$guard$;
