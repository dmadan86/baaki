-- Trip dates, and the two reminders a day that make a shared ledger work.
--
-- The failure this exists for is not technical. Four people go to Goa, and on
-- day one everybody adds everything. By day three nobody has entered a thing
-- since the first lunch, and on the flight home somebody tries to reconstruct a
-- week of autorickshaws from memory. The ledger is only as good as the habit of
-- adding to it, and the habit needs prompting while the trip is happening —
-- afterwards is too late, because the receipts are gone and so is the will.
--
-- So a group can say when it is happening, and during those dates each member
-- is asked twice a day:
--
--   * at breakfast, about yesterday — the meal where you remember last night
--   * at the end of the day, about today — while the day is still recoverable
--
-- Both are asked in the *group's* timezone, not the server's and not each
-- reader's. A trip has a place; "breakfast" means breakfast there. Waking
-- somebody in London at 04:00 to ask about dinner in Goa is worse than not
-- asking.
--
-- Nobody is asked about a day they already recorded. A reminder to do something
-- already done is how an app teaches people to ignore it.

-- ────────────────────────────────────────────────────── 1. when it happens ──

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS end_date   DATE,
  -- IANA name. Defaulted rather than nullable: every reminder needs one, and a
  -- group with no answer is India-first Baaki's home timezone.
  ADD COLUMN IF NOT EXISTS time_zone  TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS remind_daily BOOLEAN NOT NULL DEFAULT TRUE,
  -- "Breakfast" is not a fixed hour. A group of students and a group of
  -- grandparents disagree, and the one that gets it wrong gets muted.
  ADD COLUMN IF NOT EXISTS remind_morning_at TIME NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS remind_evening_at TIME NOT NULL DEFAULT '21:00';

ALTER TABLE public.groups
  DROP CONSTRAINT IF EXISTS groups_dates_in_order;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_dates_in_order
  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date);

COMMENT ON COLUMN public.groups.time_zone IS
  'IANA zone the reminders are scheduled in. A trip has a place; breakfast means breakfast there.';

-- Most groups have no dates at all, so the rows the job cares about are a small
-- minority and worth an index of their own.
CREATE INDEX IF NOT EXISTS groups_reminder_window_idx
  ON public.groups (start_date, end_date);

-- ─────────────────────────────────────────────────────── 2. the two nudges ──
-- Runs hourly and works out what each group's local time is, rather than being
-- scheduled per group. `p_now` is an argument so the whole thing can be tested
-- without waiting for 9am in another country.

CREATE OR REPLACE FUNCTION public.baaki_trip_nudges(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group    record;
  v_member   record;
  v_local    timestamp;
  v_today    date;
  v_slot     text;
  v_subject  date;
  v_written  integer := 0;
  v_id       uuid;
BEGIN
  FOR v_group IN
    SELECT id, name, time_zone, start_date, end_date,
           remind_morning_at, remind_evening_at
    FROM public.groups
    WHERE remind_daily
      AND archived_at IS NULL
      AND start_date IS NOT NULL
      AND end_date   IS NOT NULL
  LOOP
    v_local := p_now AT TIME ZONE v_group.time_zone;
    v_today := v_local::date;

    -- Inclusive of both ends: the last day of a trip is the day with the most
    -- unrecorded spending on it.
    CONTINUE WHEN v_today < v_group.start_date OR v_today > v_group.end_date;

    -- Both slots are considered on every run rather than only the latest one.
    -- If cron is down all morning, the breakfast reminder should still go out
    -- late rather than not at all, and the dedupe key is what stops it going
    -- out twice.
    FOREACH v_slot IN ARRAY ARRAY['morning', 'evening']
    LOOP
    IF v_slot = 'morning' THEN
      CONTINUE WHEN v_local::time < v_group.remind_morning_at;
      -- At breakfast the interesting day is the one that just ended. On the
      -- first morning of a trip there is no yesterday worth asking about.
      v_subject := v_today - 1;
      CONTINUE WHEN v_subject < v_group.start_date;
    ELSE
      CONTINUE WHEN v_local::time < v_group.remind_evening_at;
      v_subject := v_today;
    END IF;

    FOR v_member IN
      SELECT m.id AS member_id, m.profile_id
      FROM public.group_members m
      JOIN public.profiles p ON p.id = m.profile_id
      WHERE m.group_id = v_group.id
        AND m.profile_id IS NOT NULL
        AND m.left_at IS NULL
        -- Somebody who turned nudges off has answered this question already.
        AND COALESCE((p.notification_prefs ->> 'nudges')::boolean, TRUE)
    LOOP
      -- Nobody is asked about a day they already recorded. This is the whole
      -- difference between a useful reminder and the kind people mute.
      CONTINUE WHEN EXISTS (
        SELECT 1
        FROM public.expenses e
        JOIN public.expense_versions v ON v.id = e.current_version_id
        WHERE e.group_id = v_group.id
          AND e.deleted_at IS NULL
          AND v.author_member_id = v_member.member_id
          AND v.expense_date = v_subject
      );

      v_id := public.baaki_notify(
        v_member.profile_id,
        v_group.id,
        CASE v_slot WHEN 'morning' THEN 'trip_nudge_morning' ELSE 'trip_nudge_evening' END,
        CASE v_slot
          WHEN 'morning' THEN 'Anything from yesterday?'
          ELSE 'Add today before you forget'
        END,
        CASE v_slot
          WHEN 'morning' THEN 'Add what you spent yesterday while you still remember it'
          ELSE 'What did you pay for today?'
        END,
        'baaki://group/' || v_group.id::text || '/add-expense',
        jsonb_build_object('group', v_group.name, 'date', v_subject::text, 'slot', v_slot),
        'trip_nudge:' || v_group.id::text || ':' || v_subject::text || ':' || v_slot
          || ':' || v_member.profile_id::text
      );

      IF v_id IS NOT NULL THEN
        v_written := v_written + 1;
      END IF;
    END LOOP;
    END LOOP;
  END LOOP;

  RETURN v_written;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_trip_nudges(timestamptz) FROM PUBLIC;

-- ───────────────────────────────────────────────────────────── 3. schedule ──
-- Hourly, because "9am" means a different instant in every timezone and the
-- job resolves that itself rather than being scheduled per group. A missed run
-- is not a lost reminder: the next one still finds the slot passed and the
-- dedupe key absent, so it sends once and late rather than never.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule('baaki-trip-nudges')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'baaki-trip-nudges');
    PERFORM cron.schedule(
      'baaki-trip-nudges', '2 * * * *',
      'SELECT public.baaki_trip_nudges()'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not scheduled: %', SQLERRM;
END
$$;
