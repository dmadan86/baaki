-- Auto-archive long-untouched groups (the privacy note's retention promise).
--
-- The privacy screen tells people a group they close and leave untouched for a
-- year and a half is moved to their archive automatically, with nothing deleted
-- and reopening always available. This is the job that makes that true.
--
-- "Untouched" is measured from the last real activity, not `updated_at`: that
-- column is a Prisma `@updatedAt` and is not stamped by the raw SQL the sync
-- cursor uses, so it lies about inactivity. The honest signal is the newest of
-- the group's own creation and the last expense, settlement, or activity-log
-- entry it carries — the things a person actually does in a group.
--
-- Archiving is a plain `archived_at` write, exactly what the manual archive
-- action does. Two triggers already do the rest for free:
--   * `groups_stamp_seq` bumps `updated_seq`, so the archive syncs to every
--     member's device like any other change (TDR §4).
--   * `groups_guard_columns` forbids `anon`/`authenticated` from touching these
--     columns but exempts owner-run code, and this function is SECURITY DEFINER,
--     so it writes freely while a signed-in client still cannot.
--
-- Nothing is deleted and nothing is notified: an archive is quiet and
-- reversible, and a member who wants the group back just unarchives it. The
-- `archived_at IS NULL` predicate makes the job idempotent — a second run, or an
-- overlapping one, finds the row already archived and skips it.

CREATE OR REPLACE FUNCTION public.baaki_auto_archive_stale_groups(
  p_now timestamptz DEFAULT now(),
  p_age interval    DEFAULT interval '18 months'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row   record;
  v_count integer := 0;
BEGIN
  FOR v_row IN
    SELECT g.id
      FROM public.groups g
     WHERE g.archived_at IS NULL
       -- The last thing anyone did here. GREATEST ignores NULL arguments, so a
       -- group with no expenses/settlements/activity falls back to its own
       -- creation time — which correctly leaves a brand-new empty group alone.
       AND GREATEST(
             g.created_at,
             (SELECT max(e.created_at) FROM public.expenses e     WHERE e.group_id = g.id),
             (SELECT max(s.created_at) FROM public.settlements s  WHERE s.group_id = g.id),
             (SELECT max(a.created_at) FROM public.activity_log a WHERE a.group_id = g.id)
           ) <= p_now - p_age
     -- Locked so two overlapping runs cannot both claim the same group; the
     -- second simply finds nothing to do.
     FOR UPDATE OF g SKIP LOCKED
  LOOP
    UPDATE public.groups
       SET archived_at = p_now
     WHERE id = v_row.id;

    -- A line in the feed so the archive is explained rather than mysterious.
    -- actor NULL = "the system did this", the same convention the auto-confirm
    -- job uses.
    INSERT INTO public.activity_log
      (group_id, actor_member_id, verb, object_type, object_id, payload)
    VALUES
      (v_row.id, NULL, 'auto_archived', 'group', v_row.id,
       jsonb_build_object('reason', 'inactive', 'after', p_age::text));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

-- The job runs from cron or the service role. Handing it to `authenticated`
-- would let any signed-in person archive every group in the database.
REVOKE ALL ON FUNCTION public.baaki_auto_archive_stale_groups(timestamptz, interval) FROM PUBLIC;

-- pg_cron exists on Supabase and not in a bare Postgres container, so this is
-- guarded rather than assumed. Once a day is plenty for an 18-month threshold:
-- being archived on the day after eighteen months rather than the minute after
-- is a difference no one will feel.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule('baaki-auto-archive')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'baaki-auto-archive');
    PERFORM cron.schedule(
      'baaki-auto-archive', '30 3 * * *',
      'SELECT public.baaki_auto_archive_stale_groups()'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- A database without permission to create extensions must still migrate.
  RAISE NOTICE 'pg_cron not scheduled: %', SQLERRM;
END
$$;
