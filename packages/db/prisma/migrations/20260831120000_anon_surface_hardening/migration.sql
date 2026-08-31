-- Closing what the database linter found: everything the signed-out `anon`
-- role can still reach, and the functions whose search_path is not pinned.
--
-- None of this was an open door — every flagged function null-guards on
-- `baaki_current_profile_id()` and every table is behind RLS, so a signed-out
-- caller already got nothing back. It is the second lock: the surface a
-- signed-out request can even address should be the handful of things that
-- genuinely have to answer before sign-in, and nothing else.
--
-- ─────────────────────────────────────────────── why anon kept creeping back ──
--
-- Every migration since the definer-grant audit writes:
--
--     REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--     GRANT  ALL ON FUNCTION ... TO authenticated, service_role;
--
-- which reads as "signed-in only" and is not. Supabase ships default privileges
-- on the `public` schema that grant EXECUTE **directly to `anon`** as each
-- function is created, and a revoke FROM PUBLIC does not touch a direct grant.
-- So the audit's own pattern re-opens every function added after it: the
-- baseline carries 129 `FROM PUBLIC` revokes and not one `FROM anon`.
--
-- The house pattern from here is both lines. `FROM PUBLIC` for the implicit
-- grant, `FROM anon` for the default-privilege one:
--
--     REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;
--     GRANT  ALL ON FUNCTION ... TO authenticated, service_role;

-- ─────────────────────────────────────────── 1. pin every mutable search_path ──
--
-- A SECURITY DEFINER function without a pinned search_path resolves its
-- unqualified names against whatever the caller's search_path says, which is
-- the classic way to get one to run somebody else's `expenses` table. The
-- triggers and check functions here are not definer, but they run on every
-- write, and there is no reason for any of them to inherit a caller's path.

ALTER FUNCTION public.baaki_array_is_distinct(p_values text[]) SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_assert_fx_valid(p_fx jsonb, p_expense_currency character, p_group_currency character) SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_check_expense_totals() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_check_settlement_allocations() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_current_profile_id() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_expense_restore_window() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_forbid_mutation() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_group_balances_truth(p_group_id uuid) SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_group_from_storage_path(p_path text) SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_group_pairwise_truth(p_group_id uuid) SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_guard_group_columns() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_guard_membership_columns() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_nudge_rate_limit() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_settlement_transition() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_stamp_capture_seq() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_stamp_category_tag_seq() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_stamp_ghost_merge_seq() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_stamp_group_seq() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_stamp_personal_seq() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_stamp_seq() SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.baaki_version_key(p_version text) SET search_path = 'public', 'pg_temp';

-- ──────────────────────────── 2. the definer functions a signed-out caller had ──
--
-- Three the linter flagged, all added after the audit and all carrying its
-- incomplete revoke. Each already refuses a caller with no session —
-- `baaki_log_voice_attempt` returns NULL, the other two resolve no member and
-- raise — so this removes the ability to call them at all rather than a working
-- exploit.
--
-- The definer functions left executable by `anon` are deliberate and stay:
-- `is_group_member`, `baaki_my_member_id`, `baaki_is_expense_party`,
-- `baaki_is_settlement_party` and `baaki_version_group_id` are the helpers the
-- RLS policies themselves call, and a policy written `TO anon, authenticated`
-- has to be able to evaluate for either role.

REVOKE ALL ON FUNCTION public.baaki_delete_group(p_group_id uuid) FROM anon;
REVOKE ALL ON FUNCTION public.baaki_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.baaki_next_personal_seq(p_owner uuid) FROM anon;

-- Two more the linter has not seen yet: the settle-up cancel/dispute pair went
-- in after that scan and carries the same incomplete revoke, so they would have
-- turned up on the next one. Closed here rather than left to be rediscovered.
REVOKE ALL ON FUNCTION public.baaki_cancel_settlement(p_settlement_id uuid) FROM anon;
REVOKE ALL ON FUNCTION public.baaki_dispute_settlement(p_settlement_id uuid, p_reason text) FROM anon;

-- ─────────────────────────────────────────────── 3. tables anon may address ──
--
-- RLS already returned nothing to a signed-out caller on every one of these.
-- What the grant still bought was *discovery*: the table, its columns and its
-- relationships are published in the GraphQL schema and the OpenAPI document to
-- anyone holding the publishable key, which is in every copy of the app.
--
-- Three keep their signed-out read, because something has to answer before
-- there is a session:
--
--   • `app_releases`   — the version gate. A client too old to be trusted with
--                        the ledger is too old to sign in to it, so this is
--                        read before the sign-in screen (see fetchReleasePolicy).
--   • `country_settings` — the phone sign-in screen's country denylist.
--   • `feature_flags`  — read by a provider that can mount before the session
--                        resolves; it is public configuration, and the fetch is
--                        cached for an hour, so failing it signed-out would
--                        leave flags inert for an hour after signing in.
--
-- A guest is NOT `anon`: an anonymous sign-in issues a real JWT with the
-- `authenticated` role and `is_anonymous: true`, so every guest ceiling and
-- guest read keeps working.

REVOKE ALL ON TABLE public.activity_log FROM anon;
REVOKE ALL ON TABLE public.app_config FROM anon;
REVOKE ALL ON TABLE public.campaign_impressions FROM anon;
REVOKE ALL ON TABLE public.email_events FROM anon;
REVOKE ALL ON TABLE public.expense_attachments FROM anon;
REVOKE ALL ON TABLE public.expense_comments FROM anon;
REVOKE ALL ON TABLE public.expense_disputes FROM anon;
REVOKE ALL ON TABLE public.expense_image_events FROM anon;
REVOKE ALL ON TABLE public.expense_payers FROM anon;
REVOKE ALL ON TABLE public.expense_shares FROM anon;
REVOKE ALL ON TABLE public.expense_versions FROM anon;
REVOKE ALL ON TABLE public.expenses FROM anon;
REVOKE ALL ON TABLE public.feedback FROM anon;
REVOKE ALL ON TABLE public.ghost_merges FROM anon;
REVOKE ALL ON TABLE public.group_balances FROM anon;
REVOKE ALL ON TABLE public.group_members FROM anon;
REVOKE ALL ON TABLE public.group_passes FROM anon;
REVOKE ALL ON TABLE public.groups FROM anon;
REVOKE ALL ON TABLE public.invites FROM anon;
REVOKE ALL ON TABLE public.member_claims FROM anon;
REVOKE ALL ON TABLE public.notifications FROM anon;
REVOKE ALL ON TABLE public.pairwise_balances FROM anon;
REVOKE ALL ON TABLE public.personal_records FROM anon;
REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.promo_redemptions FROM anon;
REVOKE ALL ON TABLE public.push_tokens FROM anon;
REVOKE ALL ON TABLE public.receipt_item_claims FROM anon;
REVOKE ALL ON TABLE public.receipts FROM anon;
REVOKE ALL ON TABLE public.reminders FROM anon;
REVOKE ALL ON TABLE public.service_config FROM anon;
REVOKE ALL ON TABLE public.settlement_allocations FROM anon;
REVOKE ALL ON TABLE public.settlement_proofs FROM anon;
REVOKE ALL ON TABLE public.settlements FROM anon;
REVOKE ALL ON TABLE public.sync_mutations FROM anon;
REVOKE ALL ON TABLE public.trip_member_budgets FROM anon;
REVOKE ALL ON TABLE public.trip_photos FROM anon;
REVOKE ALL ON TABLE public.trip_plan_items FROM anon;
REVOKE ALL ON TABLE public.usage_events FROM anon;

-- `app_releases` keeps its signed-out read and loses the rest. The baseline
-- hands `anon` INSERT and UPDATE on it as well, which nothing has ever needed:
-- the row is written from the console, and the only policy on the table is a
-- read. RLS refuses those writes today; the grant should not have implied they
-- were on the table at all.
REVOKE ALL ON TABLE public.app_releases FROM anon;
GRANT SELECT ON TABLE public.app_releases TO anon;

-- The invite flow is untouched by the line above: an invite is previewed and
-- accepted through the `invite-accept` edge function on the service role, never
-- by a signed-out client reading `invites` directly.

-- ────────────────────────────────────────── 4. policies that still name anon ──
--
-- `ALTER POLICY ... TO` changes only the roles a policy applies to; the USING
-- and WITH CHECK expressions are left exactly as they are. Each of these is an
-- "is it mine" policy whose expression compares against `auth.uid()`, so it
-- could never match for a signed-out caller — naming `anon` said something the
-- policy never meant.
--
-- The other policies written `TO anon, authenticated` are not touched here:
-- their expressions go through `is_group_member`, which is false without a
-- session, and the table grants above are now the outer gate either way.

ALTER POLICY campaign_impressions_own ON public.campaign_impressions TO authenticated;
ALTER POLICY captures_own ON public.captures TO authenticated;
ALTER POLICY category_tags_own ON public.category_tags TO authenticated;
ALTER POLICY device_sessions_own_read ON public.device_sessions TO authenticated;
ALTER POLICY email_events_select_own ON public.email_events TO authenticated;
ALTER POLICY feedback_own ON public.feedback TO authenticated;
ALTER POLICY group_members_update_self ON public.group_members TO authenticated;
ALTER POLICY invites_revoke ON public.invites TO authenticated;
ALTER POLICY member_claims_visible ON public.member_claims TO authenticated;
ALTER POLICY notifications_select_own ON public.notifications TO authenticated;
ALTER POLICY notifications_update_own ON public.notifications TO authenticated;
ALTER POLICY personal_records_own ON public.personal_records TO authenticated;
ALTER POLICY promo_redemptions_own ON public.promo_redemptions TO authenticated;
ALTER POLICY push_tokens_own ON public.push_tokens TO authenticated;
ALTER POLICY service_config_select ON public.service_config TO authenticated;
ALTER POLICY subscriptions_select_own ON public.subscriptions TO authenticated;
ALTER POLICY usage_events_select_own ON public.usage_events TO authenticated;
ALTER POLICY voice_stt_usage_select_own ON public.voice_stt_usage TO authenticated;

-- ─────────────────────────────────────────────── 5. the storage-side policies ──
--
-- Same "is it mine" shape, on `storage.objects`: an owner check that cannot
-- match without a session, applied to a role that never has one.
--
-- Guarded, because `storage.objects` belongs to `supabase_storage_admin` and
-- whether the migration's role may alter its policies differs between projects.
-- A refusal here must not fail the migration and take everything above with it:
-- these six are tidiness, not the lock. If the notice appears, the same six
-- lines can be run from the SQL editor, which does hold that ownership.

DO $$
DECLARE
  v_policy text;
  v_policies text[] := ARRAY[
    'captures are readable by their owner',
    'captures are removable by their owner',
    'captures are replaceable by their owner',
    'personal receipts are readable by owner',
    'personal receipts are removable by owner',
    'personal receipts are replaceable by paid owner'
  ];
BEGIN
  FOREACH v_policy IN ARRAY v_policies LOOP
    BEGIN
      -- Only touch what is actually there: a policy renamed or dropped since
      -- the linter ran is not an error worth stopping for.
      IF EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = v_policy
      ) THEN
        EXECUTE format('ALTER POLICY %I ON storage.objects TO authenticated', v_policy);
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'storage.objects policy %: not owned by this role, left as it is', v_policy;
    END;
  END LOOP;
END
$$;
