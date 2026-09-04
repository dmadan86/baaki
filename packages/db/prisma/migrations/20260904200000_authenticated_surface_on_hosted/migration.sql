-- The signed-in surface a hosted rebuild leaves wide open.
--
-- `20260904160000_anon_surface_on_hosted` closed this for `anon` and stopped one
-- step short: it revoked ALL FUNCTIONS from `anon` but not from
-- `authenticated`. Supabase ships default privileges on `public` that grant
-- EXECUTE to both roles as each function is created, so on a hosted project
-- every function stayed callable by any signed-in user -- and a guest is
-- `authenticated`.
--
-- A local build has no such defaults, which is exactly why CI never saw it:
-- there the migrations' own GRANTs are the whole story and 107 functions are
-- reachable. The hosted project had 173. The 66-function gap included the whole
-- `waves_admin_*` console API, `waves_grant_promo` (give yourself a paid plan),
-- `waves_email_for` (any user's address), `waves_notify` (a push to anyone),
-- `waves_auto_confirm_settlements` (settle other people's money early), the
-- storage-cap accounting, and `waves_apply_expense` -- the write path that an
-- earlier migration deliberately returned to service-role only.
--
-- None of those carry an internal caller check, because under ADR-013 the grant
-- IS the boundary. That remains the right design; this restores the boundary.
--
-- The default privilege is revoked as well, so a function added later cannot
-- inherit the grant again. An explicit GRANT in its own migration is already the
-- house rule, enforced by `scripts/check-definer-grants.mjs`.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;

-- Replayed from a local build of this same migration chain, which is the only
-- place the intent exists free of Supabase's defaults.

GRANT EXECUTE ON FUNCTION public.is_group_admin(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_group_member(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_add_expense_comment(p_group_id uuid, p_expense_id uuid, p_comment_id uuid, p_body text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_add_ghost_member(p_group_id uuid, p_name text, p_member_id uuid, p_email text, p_phone text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_add_plan_item(p_group_id uuid, p_day date, p_title text, p_starts_at time without time zone, p_note text, p_category text, p_planned_minor bigint, p_currency character, p_item_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_add_trip_photo(p_group_id uuid, p_storage_path text, p_photo_id uuid, p_expense_id uuid, p_day date, p_caption text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_admin_voice_attempts(p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_annotate_expense_attachment(p_attachment_id uuid, p_annotations jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_array_is_distinct(p_values text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_assert_expense_caller(p_group_id uuid, p_author_member_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_assert_fx_valid(p_fx jsonb, p_expense_currency character, p_group_currency character) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_attach_expense_attachment(p_expense_id uuid, p_storage_path text, p_visibility text, p_attachment_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_attach_settlement_proof(p_settlement_id uuid, p_storage_path text, p_proof_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_attachment_cap() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_bucket(p_input text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_campaign_seen(p_campaign_id uuid, p_acted boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_can_add_expense_attachment(p_expense_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_can_add_receipt(p_group_id uuid, p_receipt_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_can_upload_group_photo(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_cancel_settlement(p_settlement_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_check_expense_totals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_check_settlement_allocations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_clear_my_trip_budget(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_confirm_settlement(p_settlement_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_create_group(p_name text, p_type text, p_currency character, p_emoji text, p_simplify boolean, p_group_id uuid, p_photo_path text, p_country character, p_creator_member_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_current_profile_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_decide_member_claim(p_claim_id uuid, p_approve boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_delete_expense(p_expense_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_delete_expense_comment(p_comment_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_delete_group(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_delete_my_account(p_feedback text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_device_cap(p_profile_id uuid, p_is_plus boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_dispute_expense(p_expense_id uuid, p_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_dispute_settlement(p_settlement_id uuid, p_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_edit_expense_comment(p_comment_id uuid, p_body text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_ensure_group_join_token(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_expense_restore_window() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_flag_expense_comment(p_comment_id uuid, p_flag boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_forbid_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_free_storage_cap() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_gravatar_url(p_email text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_group_balances_truth(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_group_from_storage_path(p_path text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_group_is_paid(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_group_member_claims(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_group_pairwise_truth(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_group_plan(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_group_spending(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_guard_group_columns() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_guard_membership_columns() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb, p_origin text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_import_splitwise(p_group_id uuid, p_people jsonb, p_expenses jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_is_expense_party(p_expense_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_is_settlement_party(p_settlement_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_item_claims(p_receipt_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_list_devices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_log_receipt_event(p_event_id uuid, p_group_id uuid, p_expense_id uuid, p_action text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_mark_notifications_read(p_ids uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_member_group_id(p_member_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_merge_ghosts(p_member_ids uuid[], p_name text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_my_campaign() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_my_erasure_preview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_my_member_claims() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_my_member_id(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_my_member_id_for(p_group_id uuid, p_profile_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_my_plan(p_profile_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_my_storage_usage() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_my_voice_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_nudge_rate_limit() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_nudge_to_settle(p_group_id uuid, p_to_member_id uuid, p_currency character) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_open_receipts(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_people_i_owe() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_person_group_balances(p_person_key text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_profiles_share_group(p_a uuid, p_b uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_publish_receipt_items(p_receipt_id uuid, p_items jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_receipt_cap() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_receipt_scan_quota() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_record_settlement(p_group_id uuid, p_from_member_id uuid, p_to_member_id uuid, p_amount bigint, p_method text, p_currency character, p_note text, p_allocations jsonb, p_client_mutation_id uuid, p_rail text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_redeem_promo(p_code text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_register_device(p_device_id text, p_label text, p_platform text, p_app_version text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_remove_expense_attachment(p_attachment_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_remove_plan_item(p_item_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_remove_settlement_proof(p_proof_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_remove_trip_photo(p_photo_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_replace_expense_attachment_image(p_attachment_id uuid, p_new_path text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_reset_group_join_token(p_group_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_resolve_dispute(p_dispute_id uuid, p_accept boolean, p_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_restore_expense(p_expense_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_scans_used_this_month(p_profile_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_set_category_budget(p_group_id uuid, p_category text, p_amount_minor bigint, p_currency character) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_set_group_budget(p_group_id uuid, p_amount_minor bigint, p_currency character) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_set_group_fx_rate(p_group_id uuid, p_from character, p_num bigint, p_den bigint, p_source text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_set_item_claim(p_receipt_id uuid, p_item_index integer, p_claimed boolean, p_for_member_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_set_member_role(p_member_id uuid, p_role text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_set_my_trip_budget(p_group_id uuid, p_amount_minor bigint, p_currency character, p_visibility text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_settlement_transition() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_shares_a_group_with(p_profile_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_sign_out_other_devices(p_device_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_submit_feedback(p_message text, p_kind text, p_rating integer, p_app_version text, p_platform text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_update_plan_item(p_item_id uuid, p_day date, p_starts_at time without time zone, p_title text, p_note text, p_category text, p_planned_minor bigint, p_done boolean, p_expense_id uuid, p_clear text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_variant(p_key text, p_profile_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_version_group_id(p_version_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_version_key(p_version text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_voice_stt_free_seconds() TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_withdraw_dispute(p_expense_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.waves_withdraw_member_claim(p_claim_id uuid) TO authenticated;

-- Refuse to finish unless the surface is exactly what was just declared, so a
-- later migration that widens it silently fails here instead of in production.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 107 THEN
    RAISE EXCEPTION 'signed-in function surface is %, expected 107', n;
  END IF;
END
$$;
