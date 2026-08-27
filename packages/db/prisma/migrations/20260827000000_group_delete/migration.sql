-- Delete a group, Splitwise-style: an admin drops the whole group for everyone,
-- but only once it is fully settled. ADR-004 keeps the ledger append-only, so a
-- delete is a group-wide tombstone (`groups.deleted_at`), exactly like
-- `archived_at` — except a deleted group leaves BOTH the active list and the
-- archive (an archive is recoverable; this is not shown anywhere). The rows stay.

ALTER TABLE public.groups ADD COLUMN deleted_at timestamp(6) with time zone;

--
-- Name: baaki_delete_group(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.baaki_delete_group(p_group_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile_id uuid := public.baaki_current_profile_id();
  v_deleted_at timestamptz;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in to delete a group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT deleted_at INTO v_deleted_at FROM public.groups WHERE id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such group' USING ERRCODE = 'no_data_found';
  END IF;

  -- Only an admin/owner may delete the group for everyone. The button hides for
  -- everyone else, but the client gate is a courtesy — this is the boundary.
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'NOT_ADMIN: only an admin deletes a group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Idempotent: deleting an already-deleted group is a no-op, so a retried queue
  -- flush or a second tap lands cleanly rather than raising. Checked after the
  -- admin gate so a re-delete still answers a non-admin with NOT_ADMIN.
  IF v_deleted_at IS NOT NULL THEN
    RETURN;
  END IF;

  -- The whole group must be square first — every member, in every currency.
  -- `baaki_group_balances_truth` returns only non-zero rows (ADR-004), so any row
  -- at all means somebody is still owed and the group cannot be pulled out from
  -- under them. Same source `baaki_refresh_group_balances` derives from, so this
  -- never disagrees with the stored balances.
  IF EXISTS (SELECT 1 FROM public.baaki_group_balances_truth(p_group_id)) THEN
    RAISE EXCEPTION 'NOT_SETTLED: settle every balance before deleting the group'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The tombstone. The stamp trigger bumps `updated_seq`, so the change reaches
  -- every member's mirror on their next sync and the group leaves all their lists.
  UPDATE public.groups SET deleted_at = now() WHERE id = p_group_id;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_delete_group(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.baaki_delete_group(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.baaki_delete_group(p_group_id uuid) TO service_role;
