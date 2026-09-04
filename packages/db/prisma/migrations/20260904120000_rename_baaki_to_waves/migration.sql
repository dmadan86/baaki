-- The rename, in the one place it was left undone.
--
-- Every routine in this schema was prefixed `baaki_` — the app's old name —
-- and the prefix reached further than a name usually does: the app calls these
-- by string over PostgREST, the edge functions call them by string, the error
-- messages quote them back to the caller, and a few of them write the old brand
-- into rows that people read. Renaming the app without renaming these left the
-- product called one thing and its plumbing called another.
--
-- Three steps, one transaction, and no window where a caller can see half of it:
--
--   1. Rename every routine. A rename carries its grants, its owner, and every
--      reference held by oid — triggers, policies, defaults, views — so nothing
--      else has to be re-pointed.
--   2. Rewrite the bodies. Calls between these routines are resolved by name at
--      run time, so after step 1 every internal call names a routine that no
--      longer exists. `pg_get_functiondef` gives back the whole definition
--      (security, search_path, volatility and all) and `CREATE OR REPLACE`
--      puts it back with the grants intact.
--   3. Move the rows that already carry the old name: deep links written into
--      the inbox, the two English notification bodies that used the old name as
--      a common noun ("your baaki" — the balance), and the import marker that
--      says a ledger came from this app rather than Splitwise.
--
-- The guard at the end fails the migration rather than leaving the schema half
-- renamed, because a half-rename is the one outcome nobody could debug from
-- the error the app would show.
--
-- Nothing here is reversible by `prisma migrate` alone, and it is not meant to
-- be: the app release that calls `waves_*` ships with it.

-- 1. The routines.
ALTER FUNCTION public.baaki_add_expense_comment(uuid,uuid,uuid,text) RENAME TO waves_add_expense_comment;
ALTER FUNCTION public.baaki_add_ghost_member(uuid,text,uuid,text,text) RENAME TO waves_add_ghost_member;
ALTER FUNCTION public.baaki_add_plan_item(uuid,date,text,time without time zone,text,text,bigint,character,uuid) RENAME TO waves_add_plan_item;
ALTER FUNCTION public.baaki_add_trip_photo(uuid,text,uuid,uuid,date,text) RENAME TO waves_add_trip_photo;
ALTER FUNCTION public.baaki_admin_ai_cost(integer) RENAME TO waves_admin_ai_cost;
ALTER FUNCTION public.baaki_admin_campaign_email_stats(uuid) RENAME TO waves_admin_campaign_email_stats;
ALTER FUNCTION public.baaki_admin_campaign_funnel(uuid) RENAME TO waves_admin_campaign_funnel;
ALTER FUNCTION public.baaki_admin_campaign_revenue(uuid) RENAME TO waves_admin_campaign_revenue;
ALTER FUNCTION public.baaki_admin_daily(integer) RENAME TO waves_admin_daily;
ALTER FUNCTION public.baaki_admin_feedback(integer) RENAME TO waves_admin_feedback;
ALTER FUNCTION public.baaki_admin_flag_results(text) RENAME TO waves_admin_flag_results;
ALTER FUNCTION public.baaki_admin_geo() RENAME TO waves_admin_geo;
ALTER FUNCTION public.baaki_admin_grant_promo(uuid,integer) RENAME TO waves_admin_grant_promo;
ALTER FUNCTION public.baaki_admin_logins(integer) RENAME TO waves_admin_logins;
ALTER FUNCTION public.baaki_admin_money() RENAME TO waves_admin_money;
ALTER FUNCTION public.baaki_admin_overview() RENAME TO waves_admin_overview;
ALTER FUNCTION public.baaki_admin_promo_codes() RENAME TO waves_admin_promo_codes;
ALTER FUNCTION public.baaki_admin_users(integer,integer,text,text) RENAME TO waves_admin_users;
ALTER FUNCTION public.baaki_admin_voice_attempts(integer) RENAME TO waves_admin_voice_attempts;
ALTER FUNCTION public.baaki_annotate_expense_attachment(uuid,jsonb) RENAME TO waves_annotate_expense_attachment;
ALTER FUNCTION public.baaki_apply_expense(uuid,uuid,uuid,text,text,date,character,bigint,text,jsonb,jsonb,jsonb,uuid,text,uuid,integer,jsonb,text,text,text,jsonb,jsonb) RENAME TO waves_apply_expense;
ALTER FUNCTION public.baaki_array_is_distinct(text[]) RENAME TO waves_array_is_distinct;
ALTER FUNCTION public.baaki_assert_expense_caller(uuid,uuid) RENAME TO waves_assert_expense_caller;
ALTER FUNCTION public.baaki_assert_fx_valid(jsonb,character,character) RENAME TO waves_assert_fx_valid;
ALTER FUNCTION public.baaki_attach_expense_attachment(uuid,text,text,uuid) RENAME TO waves_attach_expense_attachment;
ALTER FUNCTION public.baaki_attach_settlement_proof(uuid,text,uuid) RENAME TO waves_attach_settlement_proof;
ALTER FUNCTION public.baaki_attachment_cap() RENAME TO waves_attachment_cap;
ALTER FUNCTION public.baaki_auto_archive_stale_groups(timestamp with time zone,interval) RENAME TO waves_auto_archive_stale_groups;
ALTER FUNCTION public.baaki_auto_confirm_settlements(timestamp with time zone,interval) RENAME TO waves_auto_confirm_settlements;
ALTER FUNCTION public.baaki_bucket(text) RENAME TO waves_bucket;
ALTER FUNCTION public.baaki_campaign_cohort(uuid,uuid) RENAME TO waves_campaign_cohort;
ALTER FUNCTION public.baaki_campaign_seen(uuid,boolean) RENAME TO waves_campaign_seen;
ALTER FUNCTION public.baaki_can_add_expense_attachment(uuid) RENAME TO waves_can_add_expense_attachment;
ALTER FUNCTION public.baaki_can_add_receipt(uuid,uuid) RENAME TO waves_can_add_receipt;
ALTER FUNCTION public.baaki_can_upload_group_photo(uuid) RENAME TO waves_can_upload_group_photo;
ALTER FUNCTION public.baaki_cancel_settlement(uuid) RENAME TO waves_cancel_settlement;
ALTER FUNCTION public.baaki_check_expense_totals() RENAME TO waves_check_expense_totals;
ALTER FUNCTION public.baaki_check_settlement_allocations() RENAME TO waves_check_settlement_allocations;
ALTER FUNCTION public.baaki_claim_campaign_emails(uuid,integer) RENAME TO waves_claim_campaign_emails;
ALTER FUNCTION public.baaki_claim_email_notifications(integer) RENAME TO waves_claim_email_notifications;
ALTER FUNCTION public.baaki_claim_push_notifications(integer) RENAME TO waves_claim_push_notifications;
ALTER FUNCTION public.baaki_clear_my_trip_budget(uuid) RENAME TO waves_clear_my_trip_budget;
ALTER FUNCTION public.baaki_close_disputes_on_new_version() RENAME TO waves_close_disputes_on_new_version;
ALTER FUNCTION public.baaki_confirm_settlement(uuid) RENAME TO waves_confirm_settlement;
ALTER FUNCTION public.baaki_consume_invite(uuid) RENAME TO waves_consume_invite;
ALTER FUNCTION public.baaki_create_group(text,text,character,text,boolean,uuid,text,character,uuid) RENAME TO waves_create_group;
ALTER FUNCTION public.baaki_current_profile_id() RENAME TO waves_current_profile_id;
ALTER FUNCTION public.baaki_decide_member_claim(uuid,boolean) RENAME TO waves_decide_member_claim;
ALTER FUNCTION public.baaki_delete_expense(uuid) RENAME TO waves_delete_expense;
ALTER FUNCTION public.baaki_delete_expense_comment(uuid) RENAME TO waves_delete_expense_comment;
ALTER FUNCTION public.baaki_delete_group(uuid) RENAME TO waves_delete_group;
ALTER FUNCTION public.baaki_delete_my_account(text) RENAME TO waves_delete_my_account;
ALTER FUNCTION public.baaki_device_cap(uuid,boolean) RENAME TO waves_device_cap;
ALTER FUNCTION public.baaki_dispute_expense(uuid,text) RENAME TO waves_dispute_expense;
ALTER FUNCTION public.baaki_dispute_settlement(uuid,text) RENAME TO waves_dispute_settlement;
ALTER FUNCTION public.baaki_edit_expense_comment(uuid,text) RENAME TO waves_edit_expense_comment;
ALTER FUNCTION public.baaki_email_for(uuid) RENAME TO waves_email_for;
ALTER FUNCTION public.baaki_email_suppressed(text) RENAME TO waves_email_suppressed;
ALTER FUNCTION public.baaki_ensure_group_join_token(uuid) RENAME TO waves_ensure_group_join_token;
ALTER FUNCTION public.baaki_expense_restore_window() RENAME TO waves_expense_restore_window;
ALTER FUNCTION public.baaki_finish_campaign_emails(jsonb) RENAME TO waves_finish_campaign_emails;
ALTER FUNCTION public.baaki_finish_email(jsonb) RENAME TO waves_finish_email;
ALTER FUNCTION public.baaki_finish_push(uuid[],uuid[],text[]) RENAME TO waves_finish_push;
ALTER FUNCTION public.baaki_flag_expense_comment(uuid,boolean) RENAME TO waves_flag_expense_comment;
ALTER FUNCTION public.baaki_forbid_mutation() RENAME TO waves_forbid_mutation;
ALTER FUNCTION public.baaki_free_storage_cap() RENAME TO waves_free_storage_cap;
ALTER FUNCTION public.baaki_grant_promo(uuid,integer,text) RENAME TO waves_grant_promo;
ALTER FUNCTION public.baaki_gravatar_url(text) RENAME TO waves_gravatar_url;
ALTER FUNCTION public.baaki_group_balances_truth(uuid) RENAME TO waves_group_balances_truth;
ALTER FUNCTION public.baaki_group_from_storage_path(text) RENAME TO waves_group_from_storage_path;
ALTER FUNCTION public.baaki_group_is_paid(uuid) RENAME TO waves_group_is_paid;
ALTER FUNCTION public.baaki_group_member_claims(uuid) RENAME TO waves_group_member_claims;
ALTER FUNCTION public.baaki_group_pairwise_truth(uuid) RENAME TO waves_group_pairwise_truth;
ALTER FUNCTION public.baaki_group_plan(uuid) RENAME TO waves_group_plan;
ALTER FUNCTION public.baaki_group_spending(uuid) RENAME TO waves_group_spending;
ALTER FUNCTION public.baaki_guard_group_columns() RENAME TO waves_guard_group_columns;
ALTER FUNCTION public.baaki_guard_membership_columns() RENAME TO waves_guard_membership_columns;
ALTER FUNCTION public.baaki_handle_new_user() RENAME TO waves_handle_new_user;
ALTER FUNCTION public.baaki_import_ledger(uuid,jsonb,jsonb,jsonb,text) RENAME TO waves_import_ledger;
ALTER FUNCTION public.baaki_import_splitwise(uuid,jsonb,jsonb) RENAME TO waves_import_splitwise;
ALTER FUNCTION public.baaki_is_expense_party(uuid) RENAME TO waves_is_expense_party;
ALTER FUNCTION public.baaki_is_settlement_party(uuid) RENAME TO waves_is_settlement_party;
ALTER FUNCTION public.baaki_item_claims(uuid) RENAME TO waves_item_claims;
ALTER FUNCTION public.baaki_list_devices() RENAME TO waves_list_devices;
ALTER FUNCTION public.baaki_log_receipt_event(uuid,uuid,uuid,text) RENAME TO waves_log_receipt_event;
ALTER FUNCTION public.baaki_log_voice_attempt(text,text,boolean,integer,text,text,timestamp with time zone) RENAME TO waves_log_voice_attempt;
ALTER FUNCTION public.baaki_mark_notifications_read(uuid[]) RENAME TO waves_mark_notifications_read;
ALTER FUNCTION public.baaki_member_group_id(uuid) RENAME TO waves_member_group_id;
ALTER FUNCTION public.baaki_merge_ghosts(uuid[],text) RENAME TO waves_merge_ghosts;
ALTER FUNCTION public.baaki_my_campaign() RENAME TO waves_my_campaign;
ALTER FUNCTION public.baaki_my_erasure_preview() RENAME TO waves_my_erasure_preview;
ALTER FUNCTION public.baaki_my_member_claims() RENAME TO waves_my_member_claims;
ALTER FUNCTION public.baaki_my_member_id(uuid) RENAME TO waves_my_member_id;
ALTER FUNCTION public.baaki_my_member_id_for(uuid,uuid) RENAME TO waves_my_member_id_for;
ALTER FUNCTION public.baaki_my_plan(uuid) RENAME TO waves_my_plan;
ALTER FUNCTION public.baaki_my_storage_usage() RENAME TO waves_my_storage_usage;
ALTER FUNCTION public.baaki_my_voice_access() RENAME TO waves_my_voice_access;
ALTER FUNCTION public.baaki_new_group_join_token(uuid,boolean) RENAME TO waves_new_group_join_token;
ALTER FUNCTION public.baaki_next_capture_seq(uuid) RENAME TO waves_next_capture_seq;
ALTER FUNCTION public.baaki_next_category_tag_seq(uuid) RENAME TO waves_next_category_tag_seq;
ALTER FUNCTION public.baaki_next_ghost_merge_seq(uuid) RENAME TO waves_next_ghost_merge_seq;
ALTER FUNCTION public.baaki_next_group_seq(uuid) RENAME TO waves_next_group_seq;
ALTER FUNCTION public.baaki_next_personal_seq(uuid) RENAME TO waves_next_personal_seq;
ALTER FUNCTION public.baaki_notify(uuid,uuid,text,text,text,text,jsonb,text) RENAME TO waves_notify;
ALTER FUNCTION public.baaki_notify_fanout_trigger() RENAME TO waves_notify_fanout_trigger;
ALTER FUNCTION public.baaki_nudge_rate_limit() RENAME TO waves_nudge_rate_limit;
ALTER FUNCTION public.baaki_nudge_to_settle(uuid,uuid,character) RENAME TO waves_nudge_to_settle;
ALTER FUNCTION public.baaki_open_receipts(uuid) RENAME TO waves_open_receipts;
ALTER FUNCTION public.baaki_people_i_owe() RENAME TO waves_people_i_owe;
ALTER FUNCTION public.baaki_person_group_balances(text) RENAME TO waves_person_group_balances;
ALTER FUNCTION public.baaki_profile_is_paid(uuid) RENAME TO waves_profile_is_paid;
ALTER FUNCTION public.baaki_profiles_share_group(uuid,uuid) RENAME TO waves_profiles_share_group;
ALTER FUNCTION public.baaki_publish_receipt_items(uuid,jsonb) RENAME TO waves_publish_receipt_items;
ALTER FUNCTION public.baaki_rate_limit(text,text,integer,integer) RENAME TO waves_rate_limit;
ALTER FUNCTION public.baaki_receipt_cap() RENAME TO waves_receipt_cap;
ALTER FUNCTION public.baaki_receipt_scan_quota() RENAME TO waves_receipt_scan_quota;
ALTER FUNCTION public.baaki_record_email_event(text,text,text,jsonb) RENAME TO waves_record_email_event;
ALTER FUNCTION public.baaki_record_receipt(uuid,uuid,uuid,text,text,text,jsonb,text,integer,integer) RENAME TO waves_record_receipt;
ALTER FUNCTION public.baaki_record_settlement(uuid,uuid,uuid,bigint,text,character,text,jsonb,uuid,text) RENAME TO waves_record_settlement;
ALTER FUNCTION public.baaki_redeem_promo(text) RENAME TO waves_redeem_promo;
ALTER FUNCTION public.baaki_refresh_group_balances(uuid) RENAME TO waves_refresh_group_balances;
ALTER FUNCTION public.baaki_register_device(text,text,text,text) RENAME TO waves_register_device;
ALTER FUNCTION public.baaki_remove_expense_attachment(uuid) RENAME TO waves_remove_expense_attachment;
ALTER FUNCTION public.baaki_remove_plan_item(uuid) RENAME TO waves_remove_plan_item;
ALTER FUNCTION public.baaki_remove_settlement_proof(uuid) RENAME TO waves_remove_settlement_proof;
ALTER FUNCTION public.baaki_remove_trip_photo(uuid) RENAME TO waves_remove_trip_photo;
ALTER FUNCTION public.baaki_replace_expense_attachment_image(uuid,text) RENAME TO waves_replace_expense_attachment_image;
ALTER FUNCTION public.baaki_request_member_claim(uuid,uuid,uuid,text,uuid) RENAME TO waves_request_member_claim;
ALTER FUNCTION public.baaki_require_committed_object(text,text) RENAME TO waves_require_committed_object;
ALTER FUNCTION public.baaki_reset_group_join_token(uuid) RENAME TO waves_reset_group_join_token;
ALTER FUNCTION public.baaki_resolve_dispute(uuid,boolean,text) RENAME TO waves_resolve_dispute;
ALTER FUNCTION public.baaki_restore_expense(uuid) RENAME TO waves_restore_expense;
ALTER FUNCTION public.baaki_scans_used_this_month(uuid) RENAME TO waves_scans_used_this_month;
ALTER FUNCTION public.baaki_set_category_budget(uuid,text,bigint,character) RENAME TO waves_set_category_budget;
ALTER FUNCTION public.baaki_set_group_budget(uuid,bigint,character) RENAME TO waves_set_group_budget;
ALTER FUNCTION public.baaki_set_group_fx_rate(uuid,character,bigint,bigint,text) RENAME TO waves_set_group_fx_rate;
ALTER FUNCTION public.baaki_set_item_claim(uuid,integer,boolean,uuid) RENAME TO waves_set_item_claim;
ALTER FUNCTION public.baaki_set_member_role(uuid,text) RENAME TO waves_set_member_role;
ALTER FUNCTION public.baaki_set_my_trip_budget(uuid,bigint,character,text) RENAME TO waves_set_my_trip_budget;
ALTER FUNCTION public.baaki_settlement_transition() RENAME TO waves_settlement_transition;
ALTER FUNCTION public.baaki_shares_a_group_with(uuid) RENAME TO waves_shares_a_group_with;
ALTER FUNCTION public.baaki_sign_out_other_devices(text) RENAME TO waves_sign_out_other_devices;
ALTER FUNCTION public.baaki_stamp_capture_seq() RENAME TO waves_stamp_capture_seq;
ALTER FUNCTION public.baaki_stamp_category_tag_seq() RENAME TO waves_stamp_category_tag_seq;
ALTER FUNCTION public.baaki_stamp_ghost_merge_seq() RENAME TO waves_stamp_ghost_merge_seq;
ALTER FUNCTION public.baaki_stamp_group_seq() RENAME TO waves_stamp_group_seq;
ALTER FUNCTION public.baaki_stamp_personal_seq() RENAME TO waves_stamp_personal_seq;
ALTER FUNCTION public.baaki_stamp_seq() RENAME TO waves_stamp_seq;
ALTER FUNCTION public.baaki_storage_counts(uuid,uuid) RENAME TO waves_storage_counts;
ALTER FUNCTION public.baaki_storage_enqueue_orphan() RENAME TO waves_storage_enqueue_orphan;
ALTER FUNCTION public.baaki_storage_expire_pending(interval) RENAME TO waves_storage_expire_pending;
ALTER FUNCTION public.baaki_storage_orphan_clear(text,text) RENAME TO waves_storage_orphan_clear;
ALTER FUNCTION public.baaki_storage_orphans(integer) RENAME TO waves_storage_orphans;
ALTER FUNCTION public.baaki_storage_record(uuid,uuid,text,text,bigint,text) RENAME TO waves_storage_record;
ALTER FUNCTION public.baaki_storage_recount(text,text,bigint,text) RENAME TO waves_storage_recount;
ALTER FUNCTION public.baaki_storage_release(text,text) RENAME TO waves_storage_release;
ALTER FUNCTION public.baaki_storage_release_reservation(text,text) RENAME TO waves_storage_release_reservation;
ALTER FUNCTION public.baaki_storage_reserve(uuid,uuid,text,text,bigint,text) RENAME TO waves_storage_reserve;
ALTER FUNCTION public.baaki_submit_feedback(text,text,integer,text,text) RENAME TO waves_submit_feedback;
ALTER FUNCTION public.baaki_suppress_email(text,text,jsonb) RENAME TO waves_suppress_email;
ALTER FUNCTION public.baaki_sweep_rate_limits() RENAME TO waves_sweep_rate_limits;
ALTER FUNCTION public.baaki_touch_balances() RENAME TO waves_touch_balances;
ALTER FUNCTION public.baaki_trip_nudges(timestamp with time zone) RENAME TO waves_trip_nudges;
ALTER FUNCTION public.baaki_update_plan_item(uuid,date,time without time zone,text,text,text,bigint,boolean,uuid,text[]) RENAME TO waves_update_plan_item;
ALTER FUNCTION public.baaki_variant(text,uuid) RENAME TO waves_variant;
ALTER FUNCTION public.baaki_version_group_id(uuid) RENAME TO waves_version_group_id;
ALTER FUNCTION public.baaki_version_key(text) RENAME TO waves_version_key;
ALTER FUNCTION public.baaki_voice_stt_free_seconds() RENAME TO waves_voice_stt_free_seconds;
ALTER FUNCTION public.baaki_voice_stt_record(uuid,integer) RENAME TO waves_voice_stt_record;
ALTER FUNCTION public.baaki_voice_stt_remaining_seconds(uuid) RENAME TO waves_voice_stt_remaining_seconds;
ALTER FUNCTION public.baaki_withdraw_dispute(uuid) RENAME TO waves_withdraw_dispute;
ALTER FUNCTION public.baaki_withdraw_member_claim(uuid) RENAME TO waves_withdraw_member_claim;

-- 2. Their bodies, so an internal call still resolves.
--
-- `baaki` survives in three shapes inside a definition: the routine names
-- themselves, deep links, and prose. The one common-noun use — "a pending
-- baaki", meaning a balance — is fixed first by hand, because the blanket
-- replacement below would turn it into a sentence about the app.
DO $rebrand$
DECLARE
  routine   record;
  definition text;
BEGIN
  FOR routine IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosrc ILIKE '%baaki%'
       -- Two helpers (`is_group_member`, `is_group_admin`) call into these
       -- without carrying the prefix themselves, so the loop follows the
       -- references rather than the names. An extension's own routine is none
       -- of this schema's business.
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
       )
  LOOP
    definition := pg_get_functiondef(routine.oid);
    definition := replace(definition, 'You have a pending baaki in ', 'You have a pending balance in ');
    definition := replace(definition, 'Baaki', 'Waves');
    definition := replace(definition, 'baaki', 'waves');
    EXECUTE definition;
  END LOOP;
END
$rebrand$;

-- The fanout trigger is named after the old brand too. Its function moved with
-- the rest; only the trigger's own name is left.
ALTER TRIGGER baaki_notify_fanout_on_insert ON public.notifications
  RENAME TO waves_notify_fanout_on_insert;

-- 3. The rows that already carry the old name.

-- Deep links in the inbox. The app registers only `waves://` from this release
-- on, so a link left on the old scheme opens nothing.
UPDATE public.notifications
   SET deep_link = 'waves://' || substring(deep_link FROM 9)
 WHERE deep_link LIKE 'baaki://%';

-- The two bodies that used the old name as the common noun it was.
UPDATE public.notifications
   SET body = replace(body, 'a pending baaki in ', 'a pending balance in ')
 WHERE body LIKE '%a pending baaki in %';

UPDATE public.notifications
   SET body = replace(body, 'your baaki stays right', 'your balance stays right')
 WHERE body LIKE '%your baaki stays right%';

-- `activity_log` is deliberately left alone. Its rows say a ledger was imported
-- from `baaki`, which is what happened: the app was called that at the time.
-- The log is append-only by trigger (ADR-004) and rewriting history to agree
-- with the present is exactly what that rule exists to prevent. Nothing renders
-- the field, and the client writes `waves` from here on.

-- Any scheduled job that calls one of these by name. `cron` exists on the
-- hosted database and not in a plain Postgres, and a job table that will not
-- take an update is a warning, not a failed migration — the job is re-pointed
-- by hand and the schema is already correct.
DO $jobs$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    BEGIN
      EXECUTE $sql$
        UPDATE cron.job
           SET command = replace(command, 'baaki_', 'waves_')
         WHERE command LIKE '%baaki\_%'
      $sql$;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'cron jobs still name waves_* routines by their old name: %', SQLERRM;
    END;
  END IF;
END
$jobs$;

-- The guard. A routine still named or still naming the old brand means the
-- rewrite above skipped something, and every caller of it is about to fail at
-- run time instead of here.
DO $guard$
DECLARE
  stragglers int;
BEGIN
  SELECT count(*) INTO stragglers
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.proname ILIKE '%baaki%' OR p.prosrc ILIKE '%baaki%');
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'rebrand incomplete: % routine(s) still carry the old name', stragglers;
  END IF;
END
$guard$;
