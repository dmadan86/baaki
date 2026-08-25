-- Audit and harden the SECURITY DEFINER RPC boundary: close the `anon`/PUBLIC
-- over-grant on every definer function that no guest or pre-auth flow calls.
--
-- WHY THIS EXISTS
-- ---------------
-- Supabase runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON
-- FUNCTIONS TO anon, authenticated, service_role` (reproduced locally by
-- 20260806200000). On top of that, Postgres's own built-in default grants
-- EXECUTE on every new function TO PUBLIC. So a freshly created SECURITY DEFINER
-- function is reachable by `anon` — the UNauthenticated Supabase key — by TWO
-- independent paths: a direct `anon` grant, and membership of PUBLIC. Revoking
-- only one leaves the other open; several earlier migrations revoked `anon`
-- (or nothing) but left PUBLIC, so `has_function_privilege('anon', …)` is still
-- true today (e.g. baaki_consume_invite, whose 20260814120500 revoke missed
-- PUBLIC). Every such function then relies ENTIRELY on its own internal
-- membership/party/admin check to refuse anon — one missing check bypasses RLS.
--
-- THE CALLER MODEL (verified against apps/mobile, apps/web and supabase/functions)
-- ------------------------------------------------------------------------------
--   * A signed-in user (incl. a GUEST via signInAnonymously) runs as role
--     `authenticated` — guests are NOT role `anon`. Every app RPC is issued
--     with a session, i.e. as `authenticated`.
--   * Edge functions call RPCs either as the caller's JWT (`authenticated`) or
--     with the service-role key (`service_role`). None call an RPC as bare anon.
--   * No pre-auth screen (login / landing / invite preview) invokes any
--     `baaki_*` SECURITY DEFINER RPC; invite preview is an edge function doing
--     service-role table reads, not an RPC.
--   * => No SECURITY DEFINER RPC needs `anon` for a guest/pre-auth mutation.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Group A — member-callable RPCs: revoke anon AND PUBLIC, keep authenticated +
-- service_role (re-granted explicitly so revoking PUBLIC cannot strand a role
-- that only held EXECUTE via PUBLIC). Behaviour for real users is unchanged;
-- anon simply can no longer reach the door.
-- Group B — trigger-only / cron / edge-service-only functions: locked to
-- service_role.
--
-- LEFT WITH anon DELIBERATELY (not touched here): the five RLS-predicate helpers
-- an anon-role SELECT evaluates directly on tables that GRANT SELECT TO anon —
-- is_group_member, baaki_is_expense_party, baaki_is_settlement_party,
-- baaki_my_member_id, baaki_version_group_id. Each only ever answers about the
-- caller's OWN membership (returns nothing for a subject-less anon), and each is
-- required for anon-facing RLS to evaluate at all. Revoking anon from these
-- would break legitimate anon-role reads with "permission denied for function".
--
-- Idempotent (GRANT/REVOKE are declarative); safe to re-run. Grant/revoke only —
-- no schema-table change, so Prisma drift is unaffected.
--
-- NOTE for the concurrent invite/join-token work: this also strips
-- `authenticated` from baaki_consume_invite (Group B), matching 20260814120500's
-- stated service-role-only intent; if that flow is being reshaped, re-confirm.

-- ── Expense lifecycle, comments & disputes ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_add_expense_comment(p_group_id uuid, p_expense_id uuid, p_comment_id uuid, p_body text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_add_expense_comment(p_group_id uuid, p_expense_id uuid, p_comment_id uuid, p_body text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_assert_expense_caller(p_group_id uuid, p_author_member_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_assert_expense_caller(p_group_id uuid, p_author_member_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_delete_expense(p_expense_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_delete_expense(p_expense_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_delete_expense_comment(p_comment_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_delete_expense_comment(p_comment_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_dispute_expense(p_expense_id uuid, p_reason text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_dispute_expense(p_expense_id uuid, p_reason text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_edit_expense_comment(p_comment_id uuid, p_body text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_edit_expense_comment(p_comment_id uuid, p_body text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_flag_expense_comment(p_comment_id uuid, p_flag boolean) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_flag_expense_comment(p_comment_id uuid, p_flag boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_resolve_dispute(p_dispute_id uuid, p_accept boolean, p_note text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_resolve_dispute(p_dispute_id uuid, p_accept boolean, p_note text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_restore_expense(p_expense_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_restore_expense(p_expense_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_withdraw_dispute(p_expense_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_withdraw_dispute(p_expense_id uuid) TO authenticated, service_role;

-- ── Members, claims, roles & ghost merges ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_add_ghost_member(p_group_id uuid, p_name text, p_member_id uuid, p_email text, p_phone text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_add_ghost_member(p_group_id uuid, p_name text, p_member_id uuid, p_email text, p_phone text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_decide_member_claim(p_claim_id uuid, p_approve boolean) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_decide_member_claim(p_claim_id uuid, p_approve boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_group_member_claims(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_group_member_claims(p_group_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_member_group_id(p_member_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_member_group_id(p_member_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_merge_ghosts(p_member_ids uuid[], p_name text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_merge_ghosts(p_member_ids uuid[], p_name text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_my_member_claims() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_my_member_claims() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_my_member_id_for(p_group_id uuid, p_profile_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_my_member_id_for(p_group_id uuid, p_profile_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_set_member_role(p_member_id uuid, p_role text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_set_member_role(p_member_id uuid, p_role text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_withdraw_member_claim(p_claim_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_withdraw_member_claim(p_claim_id uuid) TO authenticated, service_role;

-- ── Trip plan items ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_add_plan_item(p_group_id uuid, p_day date, p_title text, p_starts_at time without time zone, p_note text, p_category text, p_planned_minor bigint, p_currency character, p_item_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_add_plan_item(p_group_id uuid, p_day date, p_title text, p_starts_at time without time zone, p_note text, p_category text, p_planned_minor bigint, p_currency character, p_item_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_group_plan(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_group_plan(p_group_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_remove_plan_item(p_item_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_remove_plan_item(p_item_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_update_plan_item(p_item_id uuid, p_day date, p_starts_at time without time zone, p_title text, p_note text, p_category text, p_planned_minor bigint, p_done boolean, p_expense_id uuid, p_clear text[]) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_update_plan_item(p_item_id uuid, p_day date, p_starts_at time without time zone, p_title text, p_note text, p_category text, p_planned_minor bigint, p_done boolean, p_expense_id uuid, p_clear text[]) TO authenticated, service_role;

-- ── Trip album (shared photos) ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_add_trip_photo(p_group_id uuid, p_storage_path text, p_photo_id uuid, p_expense_id uuid, p_day date, p_caption text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_add_trip_photo(p_group_id uuid, p_storage_path text, p_photo_id uuid, p_expense_id uuid, p_day date, p_caption text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_remove_trip_photo(p_photo_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_remove_trip_photo(p_photo_id uuid) TO authenticated, service_role;

-- ── Attachments, settlement proofs & receipt-image annotations ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_annotate_expense_attachment(p_attachment_id uuid, p_annotations jsonb) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_annotate_expense_attachment(p_attachment_id uuid, p_annotations jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_attach_expense_attachment(p_expense_id uuid, p_storage_path text, p_visibility text, p_attachment_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_attach_expense_attachment(p_expense_id uuid, p_storage_path text, p_visibility text, p_attachment_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_attach_settlement_proof(p_settlement_id uuid, p_storage_path text, p_proof_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_attach_settlement_proof(p_settlement_id uuid, p_storage_path text, p_proof_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_can_add_expense_attachment(p_expense_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_can_add_expense_attachment(p_expense_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_remove_expense_attachment(p_attachment_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_remove_expense_attachment(p_attachment_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_remove_settlement_proof(p_proof_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_remove_settlement_proof(p_proof_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_replace_expense_attachment_image(p_attachment_id uuid, p_new_path text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_replace_expense_attachment_image(p_attachment_id uuid, p_new_path text) TO authenticated, service_role;

-- ── Personal / account surfaces (voice, feedback, campaign, promo, account, plan) ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_campaign_seen(p_campaign_id uuid, p_acted boolean) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_campaign_seen(p_campaign_id uuid, p_acted boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_delete_my_account(p_feedback text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_delete_my_account(p_feedback text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_my_campaign() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_my_campaign() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_my_erasure_preview() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_my_erasure_preview() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_my_plan(p_profile_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_my_plan(p_profile_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_my_voice_access() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_my_voice_access() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_redeem_promo(p_code text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_redeem_promo(p_code text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_submit_feedback(p_message text, p_kind text, p_rating integer, p_app_version text, p_platform text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_submit_feedback(p_message text, p_kind text, p_rating integer, p_app_version text, p_platform text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_voice_stt_free_seconds() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_voice_stt_free_seconds() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_group_admin(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_group_admin(p_group_id uuid) TO authenticated, service_role;

-- ── Receipts, scans & item claims ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_can_add_receipt(p_group_id uuid, p_receipt_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_can_add_receipt(p_group_id uuid, p_receipt_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_log_receipt_event(p_event_id uuid, p_group_id uuid, p_expense_id uuid, p_action text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_log_receipt_event(p_event_id uuid, p_group_id uuid, p_expense_id uuid, p_action text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_publish_receipt_items(p_receipt_id uuid, p_items jsonb) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_publish_receipt_items(p_receipt_id uuid, p_items jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_receipt_scan_quota() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_receipt_scan_quota() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_scans_used_this_month(p_profile_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_scans_used_this_month(p_profile_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_set_item_claim(p_receipt_id uuid, p_item_index integer, p_claimed boolean, p_for_member_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_set_item_claim(p_receipt_id uuid, p_item_index integer, p_claimed boolean, p_for_member_id uuid) TO authenticated, service_role;

-- ── Groups, join links & photo gating ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_can_upload_group_photo(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_can_upload_group_photo(p_group_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_create_group(p_name text, p_type text, p_currency character, p_emoji text, p_simplify boolean, p_group_id uuid, p_photo_path text, p_country character, p_creator_member_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_create_group(p_name text, p_type text, p_currency character, p_emoji text, p_simplify boolean, p_group_id uuid, p_photo_path text, p_country character, p_creator_member_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_ensure_group_join_token(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_ensure_group_join_token(p_group_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_group_is_paid(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_group_is_paid(p_group_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_profiles_share_group(p_a uuid, p_b uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_profiles_share_group(p_a uuid, p_b uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_reset_group_join_token(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_reset_group_join_token(p_group_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_shares_a_group_with(p_profile_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_shares_a_group_with(p_profile_id uuid) TO authenticated, service_role;

-- ── Budgets (group / category / per-member) ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_clear_my_trip_budget(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_clear_my_trip_budget(p_group_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_set_category_budget(p_group_id uuid, p_category text, p_amount_minor bigint, p_currency character) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_set_category_budget(p_group_id uuid, p_category text, p_amount_minor bigint, p_currency character) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_set_group_budget(p_group_id uuid, p_amount_minor bigint, p_currency character) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_set_group_budget(p_group_id uuid, p_amount_minor bigint, p_currency character) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_set_my_trip_budget(p_group_id uuid, p_amount_minor bigint, p_currency character, p_visibility text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_set_my_trip_budget(p_group_id uuid, p_amount_minor bigint, p_currency character, p_visibility text) TO authenticated, service_role;

-- ── Settlements & nudges ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_confirm_settlement(p_settlement_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_confirm_settlement(p_settlement_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_nudge_to_settle(p_group_id uuid, p_to_member_id uuid, p_currency character) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_nudge_to_settle(p_group_id uuid, p_to_member_id uuid, p_currency character) TO authenticated, service_role;

-- ── Other member-callable helpers ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb, p_origin text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb, p_origin text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_import_splitwise(p_group_id uuid, p_people jsonb, p_expenses jsonb) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_import_splitwise(p_group_id uuid, p_people jsonb, p_expenses jsonb) TO authenticated, service_role;

-- ── Devices ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_list_devices() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_list_devices() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_register_device(p_device_id text, p_label text, p_platform text, p_app_version text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_register_device(p_device_id text, p_label text, p_platform text, p_app_version text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_sign_out_other_devices(p_device_id text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_sign_out_other_devices(p_device_id text) TO authenticated, service_role;

-- ── Storage (R2) accounting ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_my_storage_usage() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_my_storage_usage() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_counts(p_profile_id uuid, p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_counts(p_profile_id uuid, p_group_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_enqueue_orphan() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_enqueue_orphan() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_expire_pending(p_age interval) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_expire_pending(p_age interval) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_orphan_clear(p_logical_bucket text, p_path text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_orphan_clear(p_logical_bucket text, p_path text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_orphans(p_limit integer) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_orphans(p_limit integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_record(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_record(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_recount(p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_recount(p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_release(p_logical_bucket text, p_path text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_release(p_logical_bucket text, p_path text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_release_reservation(p_logical_bucket text, p_path text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_release_reservation(p_logical_bucket text, p_path text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_storage_reserve(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_storage_reserve(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) TO authenticated, service_role;

-- ── Per-owner monotonic sequences ──
-- Member-callable: each self-gates on the caller's membership/party/admin
-- status (a subject-less anon fails every check); anon+PUBLIC removed.
REVOKE EXECUTE ON FUNCTION public.baaki_next_capture_seq(p_owner uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_next_capture_seq(p_owner uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_next_category_tag_seq(p_owner uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_next_category_tag_seq(p_owner uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_next_ghost_merge_seq(p_owner uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_next_ghost_merge_seq(p_owner uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.baaki_next_group_seq(p_group_id uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_next_group_seq(p_group_id uuid) TO authenticated, service_role;

-- ── Group B: trigger-only, cron and edge-service-only — service_role only ──
-- baaki_auto_archive_stale_groups: cron job (pg_cron), like baaki_auto_confirm_settlements
REVOKE EXECUTE ON FUNCTION public.baaki_auto_archive_stale_groups(p_now timestamp with time zone, p_age interval) FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_auto_archive_stale_groups(p_now timestamp with time zone, p_age interval) TO service_role;
-- baaki_close_disputes_on_new_version: expense-version trigger; not an RPC
REVOKE EXECUTE ON FUNCTION public.baaki_close_disputes_on_new_version() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_close_disputes_on_new_version() TO service_role;
-- baaki_consume_invite: invite-accept edge, as service_role (20260814120500 intent)
REVOKE EXECUTE ON FUNCTION public.baaki_consume_invite(p_invite_id uuid) FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_consume_invite(p_invite_id uuid) TO service_role;
-- baaki_handle_new_user: AFTER INSERT trigger on auth.users; never an RPC
REVOKE EXECUTE ON FUNCTION public.baaki_handle_new_user() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_handle_new_user() TO service_role;
-- baaki_touch_balances: expense trigger; EXECUTE grant is irrelevant to firing
REVOKE EXECUTE ON FUNCTION public.baaki_touch_balances() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.baaki_touch_balances() TO service_role;
