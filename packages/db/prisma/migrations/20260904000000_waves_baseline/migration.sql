-- The schema, as one file.
--
-- Every routine, table, policy, trigger and grant this app has, in its current
-- shape rather than in the order it was arrived at. A fresh database — CI, a
-- laptop, a new environment — builds the whole thing in one step, and there is
-- no history to read past: no column added and later dropped, no function
-- replaced five times, and no trace of the name this app used to have.
--
-- This is a schema dump of a database with every prior migration applied, minus
-- Prisma's own `_prisma_migrations` table, with the Supabase role bootstrap
-- prepended (pg_dump omits cluster-global roles) and the persisted reference
-- data appended (a schema-only dump drops it, and both the app and the tests
-- read it).
--
-- It replaces the whole previous history, including the earlier squashed
-- baseline. There is no migration path from a database built by those files:
-- the hosted database is rebuilt from this one.

-- ─────────────────────────────────────────────────────── roles ──
-- Supabase already has these; created here so the same baseline runs against a
-- plain Postgres in CI and in the local RLS tests. Grants are per-object below
-- (from the dump); only USAGE on the schema is blanket.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: extensions; Type: SCHEMA; Schema: -; Owner: -
--

-- `IF NOT EXISTS` because a hosted Supabase project already has this schema and
-- a plain Postgres does not. The same file has to build both.
CREATE SCHEMA IF NOT EXISTS extensions;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;




--
-- Name: DeliveryStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."DeliveryStatus" AS ENUM (
    'queued',
    'sent',
    'delivered',
    'failed',
    'bounced',
    'complained',
    'suppressed'
);


--
-- Name: DevicePlatform; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."DevicePlatform" AS ENUM (
    'ios',
    'android'
);


--
-- Name: ExpenseSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ExpenseSource" AS ENUM (
    'manual',
    'imported'
);


--
-- Name: GroupType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."GroupType" AS ENUM (
    'trip',
    'home',
    'couple',
    'event',
    'friends',
    'other'
);


--
-- Name: MemberRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MemberRole" AS ENUM (
    'admin',
    'member'
);


--
-- Name: ParseStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ParseStatus" AS ENUM (
    'pending',
    'parsed',
    'failed',
    'needs_review'
);


--
-- Name: ReceiptSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ReceiptSource" AS ENUM (
    'camera',
    'gallery',
    'text_paste'
);


--
-- Name: SettlementMethod; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."SettlementMethod" AS ENUM (
    'upi',
    'cash',
    'bank',
    'other'
);


--
-- Name: SettlementStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."SettlementStatus" AS ENUM (
    'initiated',
    'confirmed',
    'auto_confirmed',
    'disputed',
    'cancelled'
);


--
-- Name: SplitType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."SplitType" AS ENUM (
    'equal',
    'exact',
    'percent',
    'shares',
    'adjustment',
    'itemized'
);


--
-- Name: is_group_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_group_admin(p_group_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.profile_id = public.waves_current_profile_id()
      AND gm.left_at IS NULL
      AND gm.role = 'admin'
  )
$$;


--
-- Name: is_group_member(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_group_member(p_group_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.profile_id = public.waves_current_profile_id()
      AND gm.left_at IS NULL
  )
$$;


--
-- Name: waves_add_expense_comment(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_add_expense_comment(p_group_id uuid, p_expense_id uuid, p_comment_id uuid, p_body text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id            uuid;
  v_body          text := btrim(COALESCE(p_body, ''));
  v_me            uuid;
  v_existing_group    uuid;
  v_existing_expense  uuid;
  v_existing_author   uuid;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_body = '' THEN
    RAISE EXCEPTION 'EMPTY_COMMENT: a comment needs some text'
      USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'COMMENT_TOO_LONG: keep it under 2000 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  v_me := public.waves_my_member_id(p_group_id);

  -- Replaying a create must return the same row, not a second one (ADR-005) —
  -- but only when the id really is a replay of THIS caller's THIS write. A
  -- collision with an unrelated comment (another group, another expense,
  -- another author) is refused rather than echoed back.
  IF p_comment_id IS NOT NULL THEN
    SELECT id, group_id, expense_id, author_member_id
      INTO v_id, v_existing_group, v_existing_expense, v_existing_author
      FROM public.expense_comments
     WHERE id = p_comment_id;
    IF v_id IS NOT NULL THEN
      IF v_existing_group = p_group_id
         AND v_existing_expense = p_expense_id
         AND v_existing_author IS NOT DISTINCT FROM v_me
      THEN
        RETURN v_id;
      END IF;
      RAISE EXCEPTION 'COMMENT_ID_CONFLICT: that id belongs to a different comment'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expenses WHERE id = p_expense_id AND group_id = p_group_id
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_EXPENSE: that expense is not in this group'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.expense_comments
    (id, group_id, expense_id, author_member_id, body)
  VALUES
    (COALESCE(p_comment_id, gen_random_uuid()), p_group_id, p_expense_id, v_me, v_body)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_add_ghost_member(uuid, text, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_add_ghost_member(p_group_id uuid, p_name text, p_member_id uuid DEFAULT NULL::uuid, p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile_id uuid := public.waves_current_profile_id();
  v_member_id  uuid;
  v_email      text := nullif(btrim(lower(coalesce(p_email, ''))), '');
  v_phone      text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_name       text := nullif(btrim(coalesce(p_name, '')), '');
  -- The notification half, filled only when a genuine new ghost is inserted.
  v_phone_bare text;
  v_target     uuid;
  v_group_name text;
  v_actor_name text;
BEGIN
  IF v_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.profile_id = v_profile_id AND gm.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A name is no longer required, because picking an email out of a contact
  -- card often carries no usable one. Something is still required.
  IF v_name IS NULL AND v_email IS NULL AND v_phone IS NULL THEN
    RAISE EXCEPTION 'NOTHING_TO_ADD: give a name, an email or a number'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A number typed without its country code cannot be assumed Indian just
  -- because this is an India-first app — somebody on a trip is exactly the
  -- person whose contacts are foreign. Reject rather than guess wrong.
  IF v_phone IS NOT NULL AND v_phone !~ '^\+' THEN
    RAISE EXCEPTION 'PHONE_NEEDS_COUNTRY_CODE: % has no country code', v_phone
      USING ERRCODE = 'check_violation';
  END IF;

  -- Replay of a queued offline mutation returns the same member (ADR-005).
  IF p_member_id IS NOT NULL THEN
    SELECT id INTO v_member_id FROM public.group_members
     WHERE id = p_member_id AND group_id = p_group_id;
    IF FOUND THEN
      RETURN v_member_id;
    END IF;
  END IF;

  -- Adding the same person twice is the common accident when picking from a
  -- contact list, and two ghosts for one human split their balance in half.
  -- Matched on contact rather than name: two people really can be called Ravi.
  IF v_email IS NOT NULL OR v_phone IS NOT NULL THEN
    SELECT gm.id INTO v_member_id
      FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.left_at IS NULL
       AND ((v_email IS NOT NULL AND gm.invite_email = v_email)
         OR (v_phone IS NOT NULL AND gm.invite_phone = v_phone))
     LIMIT 1;
    IF v_member_id IS NOT NULL THEN
      RETURN v_member_id;
    END IF;
  END IF;

  INSERT INTO public.group_members
    (id, group_id, ghost_name, joined_via, invite_email, invite_phone)
  VALUES
    (COALESCE(p_member_id, gen_random_uuid()), p_group_id,
     COALESCE(v_name, v_email, v_phone), 'ghost', v_email, v_phone)
  RETURNING id INTO v_member_id;

  -- ── Tap them if they are already on Waves ──────────────────────────────────
  -- `auth.users` stores phone as bare E.164 digits (no leading '+'), so the
  -- typed number is compared both ways. A match that is the caller, or that is
  -- already an active member here, is skipped: the first would tap yourself,
  -- the second is already inside.
  --
  -- Guarded on `auth.users` existing: the DB test suite runs these RPCs against
  -- a bare Postgres with no `auth` schema, and an unguarded read there would
  -- turn a plain ghost add into an error. No auth table means no accounts to
  -- match, so skipping the notify is exactly right.
  IF to_regclass('auth.users') IS NOT NULL AND (v_email IS NOT NULL OR v_phone IS NOT NULL) THEN
    v_phone_bare := nullif(regexp_replace(coalesce(v_phone, ''), '[^0-9]', '', 'g'), '');

    SELECT u.id INTO v_target
      FROM auth.users u
     WHERE u.deleted_at IS NULL
       AND (
         (v_email IS NOT NULL AND lower(u.email) = v_email)
         OR (v_phone_bare IS NOT NULL
             AND regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g') = v_phone_bare)
       )
     ORDER BY (v_email IS NOT NULL AND lower(u.email) = v_email) DESC
     LIMIT 1;

    IF v_target IS NOT NULL
       AND v_target <> v_profile_id
       AND NOT EXISTS (
         SELECT 1 FROM public.group_members gm
         WHERE gm.group_id = p_group_id AND gm.profile_id = v_target AND gm.left_at IS NULL
       )
    THEN
      SELECT g.name INTO v_group_name FROM public.groups g WHERE g.id = p_group_id;
      SELECT p.display_name INTO v_actor_name FROM public.profiles p WHERE p.id = v_profile_id;

      PERFORM public.waves_notify(
        v_target,
        p_group_id,
        'group_added',
        -- English fallback only; every current build re-renders from kind +
        -- payload in the reader's own language (see render.ts). `counterparty`
        -- is the fact `{actor}` reads from; `group` is `{group}`.
        coalesce(v_actor_name, 'Someone') || ' added you to ' || coalesce(v_group_name, 'a group'),
        'Tap to open the group',
        'waves://group/' || p_group_id::text,
        jsonb_build_object(
          'counterparty', coalesce(v_actor_name, ''),
          'group',        coalesce(v_group_name, '')
        ),
        'group_added:' || p_group_id::text || ':' || v_target::text
      );
    END IF;
  END IF;

  RETURN v_member_id;
END
$$;


--
-- Name: waves_add_plan_item(uuid, date, text, time without time zone, text, text, bigint, character, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_add_plan_item(p_group_id uuid, p_day date, p_title text, p_starts_at time without time zone DEFAULT NULL::time without time zone, p_note text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_planned_minor bigint DEFAULT NULL::bigint, p_currency character DEFAULT NULL::bpchar, p_item_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id       uuid;
  v_position int;
  v_currency char(3);
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF coalesce(btrim(p_title), '') = '' THEN
    RAISE EXCEPTION 'INVALID_TITLE: a plan item needs a name' USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying a create must return the same item, not a second one (ADR-005) —
  -- a planner is used on a phone with one bar of signal by definition.
  IF p_item_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.trip_plan_items WHERE id = p_item_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  SELECT COALESCE(max(position), -1) + 1 INTO v_position
  FROM public.trip_plan_items WHERE group_id = p_group_id AND day = p_day;

  INSERT INTO public.trip_plan_items
    (id, group_id, day, starts_at, title, note, category, planned_minor, currency,
     position, created_by)
  VALUES
    (COALESCE(p_item_id, gen_random_uuid()), p_group_id, p_day, p_starts_at, btrim(p_title),
     p_note, p_category, p_planned_minor, upper(v_currency), v_position,
     public.waves_my_member_id(p_group_id))
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_add_trip_photo(uuid, text, uuid, uuid, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_add_trip_photo(p_group_id uuid, p_storage_path text, p_photo_id uuid DEFAULT NULL::uuid, p_expense_id uuid DEFAULT NULL::uuid, p_day date DEFAULT NULL::date, p_caption text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF coalesce(btrim(p_storage_path), '') = '' THEN
    RAISE EXCEPTION 'INVALID_PATH: a photo needs a stored image'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying a create must return the same row, not a second one (ADR-005).
  IF p_photo_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.trip_photos WHERE id = p_photo_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  IF p_expense_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expenses WHERE id = p_expense_id AND group_id = p_group_id
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_EXPENSE: that expense is not in this group'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.trip_photos
    (id, group_id, expense_id, day, storage_path, caption, created_by)
  VALUES
    (COALESCE(p_photo_id, gen_random_uuid()), p_group_id, p_expense_id, p_day,
     btrim(p_storage_path), NULLIF(btrim(COALESCE(p_caption, '')), ''),
     public.waves_my_member_id(p_group_id))
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_admin_ai_cost(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_ai_cost(p_days integer DEFAULT 30) RETURNS TABLE(day date, currency text, events bigint, input_tokens bigint, output_tokens bigint, cost_minor numeric)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    u.created_at::date,
    u.currency::text,
    count(*),
    COALESCE(sum(u.input_tokens), 0)::bigint,
    COALESCE(sum(u.output_tokens), 0)::bigint,
    COALESCE(sum(u.cost_minor), 0)
  FROM public.usage_events u
  WHERE u.created_at >= current_date - (GREATEST(p_days, 1) - 1)
  GROUP BY 1, 2
  ORDER BY 1 DESC, 2;
$$;


--
-- Name: waves_admin_campaign_email_stats(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_campaign_email_stats(p_campaign_id uuid) RETURNS TABLE(status text, count bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT s.status, count(*)::bigint
  FROM public.campaign_email_sends s
  WHERE s.campaign_id = p_campaign_id
  GROUP BY s.status
  ORDER BY s.status;
$$;


--
-- Name: waves_admin_campaign_funnel(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_campaign_funnel(p_campaign_id uuid) RETURNS TABLE(cohort text, people bigint, seen bigint, redeemed bigint, paid bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH c AS (
    SELECT * FROM public.campaigns WHERE id = p_campaign_id
  ),
  audience AS (
    SELECT p.id AS profile_id,
           public.waves_campaign_cohort(c.id, p.id) AS cohort
      FROM public.profiles p
      CROSS JOIN c
     WHERE (c.audience_countries IS NULL OR p.country_code = ANY (c.audience_countries))
       AND p.created_at <= c.ends_at
  )
  SELECT
    a.cohort,
    count(*)::bigint,
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM public.campaign_impressions i
         WHERE i.campaign_id = p_campaign_id AND i.profile_id = a.profile_id
      )
    )::bigint,
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
          FROM public.promo_redemptions r
          JOIN c ON c.promo_code = r.code
         WHERE r.profile_id = a.profile_id
      )
    )::bigint,
    -- Paid means a real store purchase, not the giveaway. `store <> 'promo'` is
    -- the whole distinction: counting the comped rows here would report every
    -- campaign as a total success.
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
          FROM public.subscriptions s
          CROSS JOIN c
         WHERE s.profile_id = a.profile_id
           AND s.store <> 'promo'
           AND s.created_at >= c.starts_at
      )
    )::bigint
  FROM audience a
  GROUP BY a.cohort
  ORDER BY a.cohort;
$$;


--
-- Name: waves_admin_campaign_revenue(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_campaign_revenue(p_campaign_id uuid) RETURNS TABLE(cohort text, currency text, payers bigint, revenue_minor numeric)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH c AS (
    SELECT * FROM public.campaigns WHERE id = p_campaign_id
  )
  SELECT
    public.waves_campaign_cohort(c.id, s.profile_id),
    s.currency::text,
    count(DISTINCT s.profile_id)::bigint,
    COALESCE(sum(s.price_minor), 0)
  FROM public.subscriptions s
  JOIN public.profiles p ON p.id = s.profile_id
  CROSS JOIN c
  WHERE s.store <> 'promo'
    AND s.price_minor IS NOT NULL
    AND s.currency IS NOT NULL
    AND s.created_at >= c.starts_at
    AND (c.audience_countries IS NULL OR p.country_code = ANY (c.audience_countries))
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;


--
-- Name: waves_admin_daily(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_daily(p_days integer DEFAULT 30) RETURNS TABLE(day date, new_profiles bigint, new_groups bigint, new_expenses bigint, active_profiles bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH days AS (
    SELECT generate_series(
      (current_date - (GREATEST(p_days, 1) - 1))::date,
      current_date,
      interval '1 day'
    )::date AS day
  )
  SELECT
    d.day,
    (SELECT count(*) FROM public.profiles p WHERE p.created_at::date = d.day),
    (SELECT count(*) FROM public.groups g WHERE g.created_at::date = d.day),
    (SELECT count(*) FROM public.expenses e
      WHERE e.created_at::date = d.day AND e.deleted_at IS NULL),
    (SELECT count(DISTINCT m.profile_id)
       FROM public.activity_log a
       JOIN public.group_members m ON m.id = a.actor_member_id
      WHERE a.created_at::date = d.day AND m.profile_id IS NOT NULL)
  FROM days d
  ORDER BY d.day;
$$;


--
-- Name: waves_admin_feedback(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_feedback(p_limit integer DEFAULT 100) RETURNS TABLE(id uuid, kind text, message text, rating integer, app_version text, platform text, locale text, country_code text, from_deleted_account boolean, created_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    f.id, f.kind, f.message, f.rating, f.app_version, f.platform,
    f.locale, f.country_code, f.profile_id IS NULL, f.created_at
  FROM public.feedback f
  ORDER BY f.created_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 100), 1);
$$;


--
-- Name: waves_admin_flag_results(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_flag_results(p_key text) RETURNS TABLE(variant text, people bigint, expenses_created bigint, active_30d bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH enrolled AS (
    SELECT p.id AS profile_id, public.waves_variant(p_key, p.id) AS variant
      FROM public.profiles p
     WHERE public.waves_variant(p_key, p.id) IS NOT NULL
  ),
  per_person AS (
    SELECT
      e.variant,
      e.profile_id,
      (SELECT count(*)
         FROM public.expenses x
         JOIN public.group_members m ON m.id = x.created_by
        WHERE m.profile_id = e.profile_id AND x.deleted_at IS NULL) AS expenses,
      EXISTS (
        SELECT 1
          FROM public.activity_log a
          JOIN public.group_members m ON m.id = a.actor_member_id
         WHERE m.profile_id = e.profile_id
           AND a.created_at >= now() - interval '30 days'
      ) AS active
    FROM enrolled e
  )
  SELECT
    variant,
    count(*)::bigint,
    COALESCE(sum(expenses), 0)::bigint,
    count(*) FILTER (WHERE active)::bigint
  FROM per_person
  GROUP BY variant
  ORDER BY variant;
$$;


--
-- Name: waves_admin_geo(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_geo() RETURNS TABLE(country_code text, profile_count bigint, group_count bigint, expense_count bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH countries AS (
    SELECT DISTINCT country_code::text AS code FROM public.profiles
    UNION
    SELECT DISTINCT country_code::text AS code FROM public.groups
  )
  SELECT
    c.code,
    (SELECT count(*) FROM public.profiles p WHERE p.country_code::text IS NOT DISTINCT FROM c.code),
    (SELECT count(*) FROM public.groups g WHERE g.country_code::text IS NOT DISTINCT FROM c.code),
    (SELECT count(*)
       FROM public.expenses e
       JOIN public.groups g ON g.id = e.group_id
      WHERE g.country_code::text IS NOT DISTINCT FROM c.code AND e.deleted_at IS NULL)
  FROM countries c
  ORDER BY 2 DESC, 1;
$$;


--
-- Name: waves_admin_grant_promo(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_grant_promo(p_profile_id uuid, p_days integer DEFAULT 30) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_sub uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NO_SUCH_PROFILE');
  END IF;

  v_sub := public.waves_grant_promo(
    p_profile_id,
    GREATEST(COALESCE(p_days, 30), 1),
    'admin:' || p_profile_id::text || ':' || current_date::text
  );

  IF v_sub IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_GRANTED_TODAY');
  END IF;

  RETURN jsonb_build_object('ok', true, 'subscription', v_sub);
END
$$;


--
-- Name: waves_admin_logins(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_logins(p_days integer DEFAULT 30) RETURNS TABLE(day date, sign_ins bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
BEGIN
  IF to_regclass('auth.audit_log_entries') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format(
    $q$
      SELECT a.created_at::date AS day, count(*)::bigint
        FROM auth.audit_log_entries a
       WHERE a.created_at >= current_date - (%s - 1)
         AND a.payload ->> 'action' IN ('login', 'token_refreshed')
       GROUP BY 1
       ORDER BY 1 DESC
    $q$,
    GREATEST(p_days, 1)
  );
END
$_$;


--
-- Name: waves_admin_money(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_money() RETURNS TABLE(currency text, expense_count bigint, expense_minor numeric, settlement_count bigint, settlement_minor numeric)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH live AS (
    SELECT v.currency::text AS currency, v.amount
      FROM public.expenses e
      JOIN public.expense_versions v ON v.id = e.current_version_id
     WHERE e.deleted_at IS NULL
  ),
  paid AS (
    SELECT s.currency::text AS currency, s.amount
      FROM public.settlements s
     WHERE s.status = 'confirmed'
  ),
  currencies AS (
    SELECT currency FROM live UNION SELECT currency FROM paid
  )
  SELECT
    c.currency,
    (SELECT count(*) FROM live l WHERE l.currency = c.currency),
    COALESCE((SELECT sum(l.amount) FROM live l WHERE l.currency = c.currency), 0),
    (SELECT count(*) FROM paid p WHERE p.currency = c.currency),
    COALESCE((SELECT sum(p.amount) FROM paid p WHERE p.currency = c.currency), 0)
  FROM currencies c
  ORDER BY 3 DESC;
$$;


--
-- Name: waves_admin_overview(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_overview() RETURNS TABLE(profiles_total bigint, profiles_new_7d bigint, profiles_new_30d bigint, groups_total bigint, groups_new_30d bigint, groups_active_30d bigint, expenses_total bigint, expenses_new_30d bigint, expenses_deleted bigint, settlements_total bigint, settlements_confirmed bigint, active_profiles_7d bigint, active_profiles_30d bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    (SELECT count(*) FROM public.profiles),
    (SELECT count(*) FROM public.profiles WHERE created_at >= now() - interval '7 days'),
    (SELECT count(*) FROM public.profiles WHERE created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.groups),
    (SELECT count(*) FROM public.groups WHERE created_at >= now() - interval '30 days'),
    (SELECT count(DISTINCT group_id) FROM public.activity_log
      WHERE created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.expenses WHERE deleted_at IS NULL),
    (SELECT count(*) FROM public.expenses
      WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.expenses WHERE deleted_at IS NOT NULL),
    (SELECT count(*) FROM public.settlements),
    (SELECT count(*) FROM public.settlements WHERE status = 'confirmed'),
    (SELECT count(DISTINCT m.profile_id)
       FROM public.activity_log a
       JOIN public.group_members m ON m.id = a.actor_member_id
      WHERE a.created_at >= now() - interval '7 days' AND m.profile_id IS NOT NULL),
    (SELECT count(DISTINCT m.profile_id)
       FROM public.activity_log a
       JOIN public.group_members m ON m.id = a.actor_member_id
      WHERE a.created_at >= now() - interval '30 days' AND m.profile_id IS NOT NULL);
$$;


--
-- Name: waves_admin_promo_codes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_promo_codes() RETURNS TABLE(code text, tier text, days integer, max_redemptions integer, redeemed_count integer, expires_at timestamp with time zone, note text, created_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT code, tier, days, max_redemptions, redeemed_count, expires_at, note, created_at
    FROM public.promo_codes
   ORDER BY created_at DESC;
$$;


--
-- Name: waves_admin_users(integer, integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_users(p_limit integer DEFAULT 25, p_offset integer DEFAULT 0, p_name_prefix text DEFAULT NULL::text, p_country text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  v_total  bigint := 0;
  v_rows   jsonb  := '[]'::jsonb;
  v_prefix text   := nullif(btrim(coalesce(p_name_prefix, '')), '');
  v_country text  := nullif(upper(btrim(coalesce(p_country, ''))), '');
  -- The page size is clamped so one lookup cannot become a walk of the whole
  -- directory, and the offset floored at zero.
  v_limit  int    := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int    := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RETURN jsonb_build_object('total', 0, 'rows', '[]'::jsonb, 'unavailable', 'no auth schema');
  END IF;

  EXECUTE format(
    $q$
      WITH base AS (
        SELECT
          u.id,
          u.email,
          u.phone,
          (u.email_confirmed_at IS NOT NULL)  AS email_confirmed,
          COALESCE(u.is_anonymous, false)     AS is_anonymous,
          u.created_at,
          u.last_sign_in_at,
          p.display_name,
          p.country_code,
          EXISTS (
            SELECT 1 FROM public.subscriptions s
             WHERE s.profile_id = u.id
               AND s.tier = 'plus'
               AND s.status IN ('active', 'grace')
          ) AS is_plus,
          (SELECT count(*) FROM public.device_sessions d
             WHERE d.profile_id = u.id AND d.revoked_at IS NULL) AS device_count,
          (SELECT d.app_version FROM public.device_sessions d
             WHERE d.profile_id = u.id AND d.app_version IS NOT NULL
             ORDER BY d.last_seen_at DESC LIMIT 1) AS app_version,
          (SELECT d.platform FROM public.device_sessions d
             WHERE d.profile_id = u.id
             ORDER BY d.last_seen_at DESC LIMIT 1) AS platform
        FROM auth.users u
        LEFT JOIN public.profiles p ON p.id = u.id
        WHERE (%1$L IS NULL OR p.display_name ILIKE %2$L OR u.email ILIKE %2$L)
          AND (%3$L IS NULL OR p.country_code = %3$L)
      )
      SELECT
        (SELECT count(*) FROM base),
        COALESCE(
          (SELECT jsonb_agg(to_jsonb(t))
             FROM (SELECT * FROM base ORDER BY created_at DESC OFFSET %4$s LIMIT %5$s) t),
          '[]'::jsonb
        )
    $q$,
    v_prefix,                 -- %1$L  null check
    v_prefix || '%',          -- %2$L  prefix match (name + email)
    v_country,                -- %3$L  country null check + equality
    v_offset,                 -- %4$s
    v_limit                   -- %5$s
  )
  INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END
$_$;


--
-- Name: waves_admin_voice_attempts(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_admin_voice_attempts(p_limit integer DEFAULT 100) RETURNS TABLE(id uuid, profile_id uuid, transcript text, locale text, used_model boolean, item_count integer, platform text, app_version text, client_at timestamp with time zone, created_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    v.id, v.profile_id, v.transcript, v.locale, v.used_model, v.item_count,
    v.platform, v.app_version, v.client_at, v.created_at
  FROM public.voice_attempts v
  ORDER BY v.created_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 100), 1);
$$;


--
-- Name: waves_annotate_expense_attachment(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_annotate_expense_attachment(p_attachment_id uuid, p_annotations jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_expense_id uuid;
BEGIN
  SELECT expense_id INTO v_expense_id
  FROM public.expense_attachments
  WHERE id = p_attachment_id AND deleted_at IS NULL;
  IF v_expense_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT public.waves_is_expense_party(v_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may mark up this image'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_attachments
     SET annotations = p_annotations
   WHERE id = p_attachment_id AND deleted_at IS NULL;
END
$$;


--
-- Name: waves_apply_expense(uuid, uuid, uuid, text, text, date, character, bigint, text, jsonb, jsonb, jsonb, uuid, text, uuid, integer, jsonb, text, text, text, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_apply_expense(p_group_id uuid, p_expense_id uuid, p_author_member_id uuid, p_description text, p_category text, p_expense_date date, p_currency character, p_amount bigint, p_split_type text, p_split_params jsonb, p_payers jsonb, p_shares jsonb, p_client_mutation_id uuid, p_notes text DEFAULT NULL::text, p_receipt_id uuid DEFAULT NULL::uuid, p_base_version_no integer DEFAULT NULL::integer, p_fx jsonb DEFAULT NULL::jsonb, p_source text DEFAULT 'manual'::text, p_payment_method text DEFAULT NULL::text, p_receipt_share_url text DEFAULT NULL::text, p_category_meta jsonb DEFAULT NULL::jsonb, p_location jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_existing        RECORD;
  v_version_no      int;
  v_version_id      uuid;
  v_is_new          boolean := false;
  v_row             jsonb;
  v_unknown         int;
  v_conflict        boolean := false;
  v_superseded_no   int;
  v_superseded_by   uuid;
  v_superseded_desc text;
  v_group_currency  char(3);
BEGIN
  -- This function is SECURITY DEFINER: verify the caller is a live member of the
  -- group before it moves a balance (security hardening).
  PERFORM public.waves_assert_expense_caller(p_group_id, p_author_member_id);

  -- Replay of a mutation we already applied (ADR-005).
  IF p_client_mutation_id IS NOT NULL THEN
    SELECT ev.id, ev.expense_id, ev.version_no INTO v_existing
    FROM public.expense_versions ev
    WHERE ev.client_mutation_id = p_client_mutation_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'expenseId', v_existing.expense_id,
        'versionId', v_existing.id,
        'versionNo', v_existing.version_no,
        'replayed', true
      );
    END IF;
  END IF;

  -- A rate that converts the wrong way is worse than no rate: it converts
  -- confidently and wrongly. Checked before a single row is written.
  SELECT g.default_currency INTO v_group_currency FROM public.groups g WHERE g.id = p_group_id;
  PERFORM public.waves_assert_fx_valid(p_fx, upper(p_currency)::char(3), v_group_currency);

  -- Every member referenced must belong to this group; a caller cannot smuggle
  -- in somebody else's member id (ADR-013).
  SELECT count(*) INTO v_unknown
  FROM (
    SELECT (value ->> 'memberId')::uuid AS member_id FROM jsonb_array_elements(p_payers)
    UNION
    SELECT (value ->> 'memberId')::uuid FROM jsonb_array_elements(p_shares)
    UNION
    SELECT p_author_member_id
  ) referenced
  WHERE referenced.member_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.id = referenced.member_id AND gm.group_id = p_group_id
    );
  IF v_unknown > 0 THEN
    RAISE EXCEPTION 'UNKNOWN_MEMBER: % member(s) are not in this group', v_unknown
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF p_expense_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.expenses WHERE id = p_expense_id) THEN
    v_is_new := true;
    INSERT INTO public.expenses (id, group_id, created_by)
    VALUES (COALESCE(p_expense_id, gen_random_uuid()), p_group_id, p_author_member_id)
    RETURNING id INTO p_expense_id;
    v_version_no := 1;
  ELSE
    IF (SELECT group_id FROM public.expenses WHERE id = p_expense_id) <> p_group_id THEN
      RAISE EXCEPTION 'WRONG_GROUP: that expense belongs to another group'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(max(version_no), 0) + 1 INTO v_version_no
    FROM public.expense_versions WHERE expense_id = p_expense_id;

    -- Somebody else wrote a version after the one this client was looking at.
    -- Append-only means both survive; the later receipt — this one — wins.
    IF p_base_version_no IS NOT NULL AND p_base_version_no < v_version_no - 1 THEN
      v_conflict := true;
      SELECT ev.version_no, ev.author_member_id, ev.description
        INTO v_superseded_no, v_superseded_by, v_superseded_desc
        FROM public.expense_versions ev
        JOIN public.expenses e ON e.id = ev.expense_id AND e.current_version_id = ev.id
       WHERE ev.expense_id = p_expense_id;
    END IF;
  END IF;

  INSERT INTO public.expense_versions
    (expense_id, version_no, author_member_id, description, category, category_meta, expense_date,
     currency, amount, split_type, split_params, receipt_id, notes, payment_method,
     receipt_share_url, location, client_mutation_id, fx, source)
  VALUES
    (p_expense_id, v_version_no, p_author_member_id, p_description, p_category, p_category_meta, p_expense_date,
     upper(p_currency), p_amount, p_split_type::"SplitType", p_split_params, p_receipt_id,
     p_notes, p_payment_method, p_receipt_share_url, p_location, p_client_mutation_id, p_fx,
     COALESCE(p_source, 'manual')::"ExpenseSource")
  RETURNING id INTO v_version_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_payers) LOOP
    INSERT INTO public.expense_payers (expense_version_id, member_id, amount)
    VALUES (v_version_id, (v_row ->> 'memberId')::uuid, (v_row ->> 'amount')::bigint);
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_shares) LOOP
    INSERT INTO public.expense_shares (expense_version_id, member_id, amount)
    VALUES (v_version_id, (v_row ->> 'memberId')::uuid, (v_row ->> 'amount')::bigint);
  END LOOP;

  -- Pointing at the new version is what makes the edit live.
  UPDATE public.expenses SET current_version_id = v_version_id WHERE id = p_expense_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    p_group_id, p_author_member_id,
    CASE WHEN v_is_new THEN 'added' ELSE 'edited' END,
    'expense', p_expense_id,
    jsonb_build_object(
      'description', p_description,
      'amount', p_amount::text,
      'currency', upper(p_currency),
      'versionNo', v_version_no,
      'source', COALESCE(p_source, 'manual')
    )
  );

  -- A second entry, so the person whose edit lost can find it. Their version is
  -- still in `expense_versions` and restoring it is just another edit.
  IF v_conflict THEN
    INSERT INTO public.activity_log
      (group_id, actor_member_id, verb, object_type, object_id, payload)
    VALUES (
      p_group_id, p_author_member_id, 'superseded', 'expense', p_expense_id,
      jsonb_build_object(
        'supersededVersionNo', v_superseded_no,
        'supersededAuthorMemberId', v_superseded_by,
        'supersededDescription', v_superseded_desc,
        'baseVersionNo', p_base_version_no,
        'winningVersionNo', v_version_no
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'expenseId', p_expense_id,
    'versionId', v_version_id,
    'versionNo', v_version_no,
    'replayed', false,
    'superseded', v_conflict,
    'supersededVersionNo', v_superseded_no
  );
END
$$;


--
-- Name: waves_array_is_distinct(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_array_is_distinct(p_values text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p_values IS NULL
      OR cardinality(p_values) = (SELECT count(DISTINCT v) FROM unnest(p_values) AS v);
$$;


--
-- Name: waves_assert_expense_caller(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_assert_expense_caller(p_group_id uuid, p_author_member_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_me      uuid;
  v_profile uuid := public.waves_current_profile_id();
BEGIN
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- An expense records who wrote it, and the version rows are append-only, so
  -- a wrong name on one is permanent. A client may only ever write as itself.
  v_me := public.waves_my_member_id_for(p_group_id, v_profile);
  IF p_author_member_id IS NOT NULL AND p_author_member_id IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'NOT_THE_AUTHOR: an expense is recorded as written by whoever wrote it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;


--
-- Name: waves_assert_fx_valid(jsonb, character, character); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_assert_fx_valid(p_fx jsonb, p_expense_currency character, p_group_currency character) RETURNS void
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  v_num numeric;
  v_den numeric;
BEGIN
  IF p_fx IS NULL THEN
    RETURN;
  END IF;

  IF p_expense_currency = p_group_currency THEN
    RAISE EXCEPTION 'FX_NOT_NEEDED: fx rate supplied for an expense already in the group currency (%)',
      p_group_currency
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_fx ->> 'from' IS DISTINCT FROM p_expense_currency THEN
    RAISE EXCEPTION 'FX_DIRECTION: fx rate converts from % but the expense is in %',
      COALESCE(p_fx ->> 'from', 'nothing'), p_expense_currency
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_fx ->> 'to' IS DISTINCT FROM p_group_currency THEN
    RAISE EXCEPTION 'FX_DIRECTION: fx rate converts to % but the group settles in %',
      COALESCE(p_fx ->> 'to', 'nothing'), p_group_currency
      USING ERRCODE = 'check_violation';
  END IF;

  -- Stored as strings so a bigint numerator survives JSON without becoming a
  -- double. They still have to be positive integers.
  IF (p_fx ->> 'num') !~ '^[0-9]+$' OR (p_fx ->> 'den') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'FX_NOT_RATIONAL: fx rate numerator and denominator must be integer strings'
      USING ERRCODE = 'check_violation';
  END IF;

  v_num := (p_fx ->> 'num')::numeric;
  v_den := (p_fx ->> 'den')::numeric;
  IF v_num <= 0 OR v_den <= 0 THEN
    RAISE EXCEPTION 'FX_NOT_RATIONAL: fx rate must be positive' USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(p_fx ->> 'source', '') = '' THEN
    RAISE EXCEPTION 'FX_NO_PROVENANCE: fx rate must say where it came from (ADR-003)'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (p_fx ->> 'ts') IS NULL THEN
    RAISE EXCEPTION 'FX_NO_PROVENANCE: fx rate must carry the instant it was captured (ADR-003)'
      USING ERRCODE = 'check_violation';
  END IF;
END
$_$;


--
-- Name: waves_attach_expense_attachment(uuid, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_attach_expense_attachment(p_expense_id uuid, p_storage_path text, p_visibility text DEFAULT 'group'::text, p_attachment_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_member   uuid;
  v_id       uuid;
BEGIN
  IF coalesce(btrim(p_storage_path), '') = '' THEN
    RAISE EXCEPTION 'INVALID_PATH: an attachment needs a stored image'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_visibility NOT IN ('group', 'parties') THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY: group or parties' USING ERRCODE = 'check_violation';
  END IF;

  -- The key MUST be scoped to this expense: `<expenseId>/…` (see the proof RPC).
  IF p_storage_path NOT LIKE p_expense_id::text || '/%' THEN
    RAISE EXCEPTION 'INVALID_PATH: the key must be scoped to its expense'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Authorise before resolving the client id (an existence oracle otherwise).
  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.waves_is_expense_party(p_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a payer or the author may attach to this expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Replay bound to the subject: same id + same expense returns the existing row
  -- (and, because it returns here, never emits a second audit line and is never
  -- re-counted against the cap).
  IF p_attachment_id IS NOT NULL THEN
    SELECT id INTO v_id
    FROM public.expense_attachments
    WHERE id = p_attachment_id AND expense_id = p_expense_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  -- The bytes must really exist: a committed object at this key, in the
  -- attachments bucket. Blocks a phantom / never-uploaded / pending-only path
  -- from being recorded as an attachment. Checked for a genuinely new row only.
  PERFORM public.waves_require_committed_object('expense-attachments', btrim(p_storage_path));

  -- Serialize the count-then-insert against other attaches to THIS expense: a
  -- transaction-scoped advisory lock keyed on the expense id. Without it two
  -- concurrent adds could both read a live count below the cap and both insert,
  -- landing one over (the same race the ghost-merge path guards). Only other
  -- attach calls take this key, so it never blocks unrelated writers, and it is
  -- released at commit. Taken before the count so a paid group pays only a
  -- trivial, uncontended lock and nothing else.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_expense_id::text, 0));

  -- The per-expense ceiling, enforced at the one insert path. A paid group is
  -- exempt; only live (non-deleted) attachments count, so removing one frees a
  -- slot.
  IF NOT public.waves_group_is_paid(v_group_id)
     AND (SELECT count(*) FROM public.expense_attachments
           WHERE expense_id = p_expense_id AND deleted_at IS NULL)
         >= public.waves_attachment_cap()
  THEN
    RAISE EXCEPTION 'ATTACHMENT_CAP'
      USING ERRCODE = 'check_violation',
            HINT = 'This expense has reached its free receipt limit; upgrade to add more.';
  END IF;

  v_member := public.waves_my_member_id(v_group_id);

  INSERT INTO public.expense_attachments
    (id, expense_id, group_id, uploader_member_id, storage_path, visibility)
  VALUES
    (COALESCE(p_attachment_id, gen_random_uuid()), p_expense_id, v_group_id, v_member,
     btrim(p_storage_path), p_visibility)
  RETURNING id INTO v_id;

  INSERT INTO public.expense_image_events
    (id, group_id, expense_id, actor_member_id, kind, action, visibility)
  VALUES
    (gen_random_uuid(), v_group_id, p_expense_id, v_member, 'attachment', 'added', p_visibility);

  RETURN v_id;
END
$$;


--
-- Name: waves_attach_settlement_proof(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_attach_settlement_proof(p_settlement_id uuid, p_storage_path text, p_proof_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_member   uuid;
  v_id       uuid;
BEGIN
  IF coalesce(btrim(p_storage_path), '') = '' THEN
    RAISE EXCEPTION 'INVALID_PATH: a proof needs a stored image' USING ERRCODE = 'check_violation';
  END IF;

  -- The object key MUST be scoped to this subject: `<settlementId>/…`. This is
  -- the canonical contract the client and r2-sign both hold, and it stops a party
  -- to one settlement recording a path under another's prefix.
  IF p_storage_path NOT LIKE p_settlement_id::text || '/%' THEN
    RAISE EXCEPTION 'INVALID_PATH: the key must be scoped to its settlement'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Authorise BEFORE resolving the client-supplied id. Resolving first would let
  -- a non-party who guesses an existing id short-circuit to a success (an
  -- existence oracle), and skip the party check entirely.
  SELECT group_id INTO v_group_id FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.waves_is_settlement_party(p_settlement_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only the payer or payee may attach a proof'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Replay: the SAME id for the SAME settlement returns the existing row. Bound
  -- to the subject so a reused id against a different settlement cannot pass.
  IF p_proof_id IS NOT NULL THEN
    SELECT id INTO v_id
    FROM public.settlement_proofs
    WHERE id = p_proof_id AND settlement_id = p_settlement_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  -- The bytes must really exist: a committed object at this key, in the
  -- settlement-proofs bucket. Blocks a phantom / never-uploaded / pending-only
  -- path. Checked for a genuinely new row only (a replay returned above).
  PERFORM public.waves_require_committed_object('settlement-proofs', btrim(p_storage_path));

  -- One live proof per settlement. A replay reuses the same id (caught above);
  -- a genuine second attach must remove the first — a proof is immutable.
  IF EXISTS (
    SELECT 1 FROM public.settlement_proofs
    WHERE settlement_id = p_settlement_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PROOF_EXISTS: this settlement already has a proof; remove it first'
      USING ERRCODE = 'unique_violation';
  END IF;

  v_member := public.waves_my_member_id(v_group_id);

  INSERT INTO public.settlement_proofs
    (id, settlement_id, group_id, uploader_member_id, storage_path)
  VALUES
    (COALESCE(p_proof_id, gen_random_uuid()), p_settlement_id, v_group_id, v_member,
     btrim(p_storage_path))
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_attachment_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_attachment_cap() RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT COALESCE((SELECT value FROM public.app_config WHERE key = 'attachment_cap_per_expense'), 2);
$$;


--
-- Name: waves_auto_archive_stale_groups(timestamp with time zone, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_auto_archive_stale_groups(p_now timestamp with time zone DEFAULT now(), p_age interval DEFAULT '1 year 6 mons'::interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
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


--
-- Name: waves_auto_confirm_settlements(timestamp with time zone, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_auto_confirm_settlements(p_now timestamp with time zone DEFAULT now(), p_window interval DEFAULT '7 days'::interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_row     record;
  v_count   integer := 0;
  v_amount  text;
BEGIN
  FOR v_row IN
    SELECT s.id,
           s.group_id,
           s.amount,
           s.currency,
           s.from_member_id,
           s.to_member_id,
           g.name                AS group_name,
           payer.profile_id      AS payer_profile,
           -- A member is either a real profile or a ghost standing in for
           -- somebody who has not joined; the name lives in whichever it is.
           COALESCE(payer_profile.display_name, payer.ghost_name) AS payer_name,
           payee.profile_id      AS payee_profile,
           COALESCE(payee_profile.display_name, payee.ghost_name) AS payee_name
    FROM public.settlements s
    JOIN public.groups g            ON g.id = s.group_id
    JOIN public.group_members payer ON payer.id = s.from_member_id
    JOIN public.group_members payee ON payee.id = s.to_member_id
    LEFT JOIN public.profiles payer_profile ON payer_profile.id = payer.profile_id
    LEFT JOIN public.profiles payee_profile ON payee_profile.id = payee.profile_id
    WHERE s.status = 'initiated'
      AND s.initiated_at <= p_now - p_window
    -- Locked so two overlapping runs of the job cannot both claim the same
    -- settlement; the second simply finds nothing to do.
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.settlements
       SET status = 'auto_confirmed'
     WHERE id = v_row.id;

    INSERT INTO public.activity_log
      (group_id, actor_member_id, verb, object_type, object_id, payload)
    VALUES
      (v_row.group_id, NULL, 'auto_confirmed', 'settlement', v_row.id,
       jsonb_build_object('amount', v_row.amount::text, 'currency', v_row.currency,
                          'reason', 'no_response_in_window'));

    v_amount := v_row.amount::text;

    -- Both people are told, and the wording differs because their positions
    -- do. The payee is the one who might want to dispute it.
    PERFORM public.waves_notify(
      v_row.payee_profile, v_row.group_id, 'settlement_confirmed',
      'Settled automatically',
      COALESCE(v_row.payer_name, 'Someone') || ' paid you, and nobody said otherwise for a week',
      'waves://group/' || v_row.group_id::text,
      jsonb_build_object('settlementId', v_row.id, 'amount', v_amount,
                         'currency', v_row.currency, 'role', 'payee',
                         'counterparty', v_row.payer_name, 'group', v_row.group_name),
      'auto_confirm:' || v_row.id::text || ':payee'
    );

    PERFORM public.waves_notify(
      v_row.payer_profile, v_row.group_id, 'settlement_confirmed',
      'Settled automatically',
      'Your payment to ' || COALESCE(v_row.payee_name, 'them') || ' was confirmed after a week',
      'waves://group/' || v_row.group_id::text,
      jsonb_build_object('settlementId', v_row.id, 'amount', v_amount,
                         'currency', v_row.currency, 'role', 'payer',
                         'counterparty', v_row.payee_name, 'group', v_row.group_name),
      'auto_confirm:' || v_row.id::text || ':payer'
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;


--
-- Name: waves_bucket(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_bucket(p_input text) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_bytes bytea := convert_to(COALESCE(p_input, ''), 'UTF8');
  v_hash bigint := 2166136261;
  v_index integer;
BEGIN
  FOR v_index IN 0 .. length(v_bytes) - 1 LOOP
    v_hash := v_hash # get_byte(v_bytes, v_index)::bigint;
    v_hash := (v_hash * 16777619) % 4294967296;
  END LOOP;
  RETURN (v_hash % 100)::integer;
END
$$;


--
-- Name: waves_campaign_cohort(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_campaign_cohort(p_campaign_id uuid, p_profile_id uuid) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT CASE
    WHEN p_profile_id IS NULL THEN NULL
    WHEN public.waves_bucket('campaign:' || p_campaign_id::text || ':' || p_profile_id::text)
         < (SELECT holdout_percent FROM public.campaigns WHERE id = p_campaign_id)
      THEN 'holdout'
    ELSE 'targeted'
  END;
$$;


--
-- Name: waves_campaign_seen(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_campaign_seen(p_campaign_id uuid, p_acted boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
BEGIN
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.campaign_impressions (campaign_id, profile_id, acted_at)
  VALUES (p_campaign_id, v_profile, CASE WHEN p_acted THEN now() ELSE NULL END)
  ON CONFLICT (campaign_id, profile_id) DO UPDATE
    SET acted_at = COALESCE(public.campaign_impressions.acted_at, EXCLUDED.acted_at);
END
$$;


--
-- Name: waves_can_add_expense_attachment(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_can_add_expense_attachment(p_expense_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
BEGIN
  IF p_expense_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RETURN false;
  END IF;

  -- Only a party may attach; a non-party gets no affordance and no count.
  IF NOT public.waves_is_expense_party(p_expense_id) THEN
    RETURN false;
  END IF;

  IF public.waves_group_is_paid(v_group_id) THEN
    RETURN true;
  END IF;

  RETURN (
    SELECT count(*) FROM public.expense_attachments
     WHERE expense_id = p_expense_id AND deleted_at IS NULL
  ) < public.waves_attachment_cap();
END
$$;


--
-- Name: waves_can_add_receipt(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_can_add_receipt(p_group_id uuid, p_receipt_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
BEGIN
  IF v_profile IS NULL OR p_group_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.profile_id = v_profile
       AND gm.left_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  -- A re-parse of a receipt that already belongs to this group is an update,
  -- never a new row against the ceiling. Exactly the recorder's exemption, so
  -- the gate cannot refuse what the boundary would allow.
  IF p_receipt_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.receipts
     WHERE id = p_receipt_id
       AND group_id = p_group_id
  ) THEN
    RETURN true;
  END IF;

  IF public.waves_group_is_paid(p_group_id) THEN
    RETURN true;
  END IF;

  RETURN (SELECT count(*) FROM public.receipts WHERE group_id = p_group_id)
         < public.waves_receipt_cap();
END
$$;


--
-- Name: waves_can_upload_group_photo(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_can_upload_group_photo(p_group_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
BEGIN
  IF v_profile IS NULL THEN
    RETURN false;
  END IF;

  IF p_group_id IS NULL THEN
    RETURN public.waves_profile_is_paid(v_profile);
  END IF;

  -- Only a member may ask about their group.
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.profile_id = v_profile
       AND gm.left_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.left_at IS NULL
       AND gm.profile_id IS NOT NULL
       AND public.waves_profile_is_paid(gm.profile_id)
  ) OR EXISTS (
    SELECT 1 FROM public.group_passes gp
     WHERE gp.group_id = p_group_id
       AND gp.expires_at > now()
  );
END
$$;


--
-- Name: waves_cancel_settlement(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_cancel_settlement(p_settlement_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_from     uuid;
  v_status   public."SettlementStatus";
  v_actor    uuid;
BEGIN
  SELECT group_id, from_member_id, status INTO v_group_id, v_from, v_status
  FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.waves_my_member_id(v_group_id);
  -- Only the payer withdraws their own claim. The payee's tool is dispute — the
  -- mirror image, so neither party can silently erase the other's record.
  IF v_actor IS NULL OR v_actor <> v_from THEN
    RAISE EXCEPTION 'NOT_THE_PAYER: only the person who recorded the payment can cancel it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Idempotent replay: an offline mutation that already landed cancels nothing
  -- a second time. Returns rather than re-writing so the activity log stays at
  -- one entry per real action.
  IF v_status = 'cancelled' THEN
    RETURN;
  END IF;

  -- Only a still-pending claim can be pulled. A confirmed settlement has cleared
  -- a debt somebody agreed to; unwinding that is a new expense, not a cancel.
  IF v_status <> 'initiated' THEN
    RAISE EXCEPTION 'NOT_CANCELLABLE: only a pending settlement can be cancelled'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.settlements SET status = 'cancelled' WHERE id = p_settlement_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_actor, 'cancelled', 'settlement', p_settlement_id, '{}'::jsonb);
END
$$;


--
-- Name: waves_check_expense_totals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_check_expense_totals() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_version_id uuid;
  v_amount     bigint;
  v_payers     bigint;
  v_shares     bigint;
BEGIN
  -- NEW/OLD only exist for the right operations, and only the child tables
  -- carry expense_version_id, so resolve the version id explicitly.
  IF TG_TABLE_NAME = 'expense_versions' THEN
    v_version_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_version_id := OLD.expense_version_id;
  ELSE
    v_version_id := NEW.expense_version_id;
  END IF;

  SELECT amount INTO v_amount FROM public.expense_versions WHERE id = v_version_id;
  IF v_amount IS NULL THEN
    RETURN NULL; -- version was removed in the same transaction
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_payers
    FROM public.expense_payers WHERE expense_version_id = v_version_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_shares
    FROM public.expense_shares WHERE expense_version_id = v_version_id;

  IF v_payers <> v_amount THEN
    RAISE EXCEPTION
      'PAYER_MISMATCH: payers sum to % but the expense is % (version %)',
      v_payers, v_amount, v_version_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_shares <> v_amount THEN
    RAISE EXCEPTION
      'SHARE_MISMATCH: shares sum to % but the expense is % (version %)',
      v_shares, v_amount, v_version_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;


--
-- Name: waves_check_settlement_allocations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_check_settlement_allocations() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_settlement_id uuid;
  v_amount        bigint;
  v_allocated     bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_settlement_id := OLD.settlement_id;
  ELSE
    v_settlement_id := NEW.settlement_id;
  END IF;
  SELECT amount INTO v_amount FROM public.settlements WHERE id = v_settlement_id;
  IF v_amount IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_allocated
    FROM public.settlement_allocations WHERE settlement_id = v_settlement_id;

  IF v_allocated > v_amount THEN
    RAISE EXCEPTION
      'ALLOCATION_EXCEEDS_SETTLEMENT: allocated % of a % settlement', v_allocated, v_amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;


--
-- Name: waves_claim_campaign_emails(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_claim_campaign_emails(p_campaign_id uuid, p_limit integer DEFAULT 100) RETURNS TABLE(send_id uuid, address text, locale text, title text, body text, cta_label text, promo_code text, ends_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
-- The OUT columns (address, title, body, …) share names with columns of the
-- tables joined below. RETURN QUERY matches by position, not name, so prefer the
-- column every time rather than have a qualified reference read as an OUT
-- variable and raise "column reference is ambiguous".
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH c AS (
    SELECT * FROM public.campaigns WHERE id = p_campaign_id
  ),
  eligible AS (
    SELECT p.id AS profile_id
    FROM public.profiles p
    CROSS JOIN c
    -- Only while the campaign is live. A send before it starts or after it ends
    -- is a send the funnel cannot attribute, so it is not allowed to happen.
    WHERE now() BETWEEN c.starts_at AND c.ends_at
      AND (c.audience_countries IS NULL OR p.country_code = ANY (c.audience_countries))
      AND public.waves_campaign_cohort(c.id, p.id) = 'targeted'
      AND COALESCE((p.notification_prefs ->> 'email')::boolean, TRUE)
      AND public.waves_email_for(p.id) IS NOT NULL
      AND NOT public.waves_email_suppressed(public.waves_email_for(p.id))
      AND NOT EXISTS (
        SELECT 1 FROM public.campaign_email_sends s
        WHERE s.campaign_id = c.id AND s.profile_id = p.id
      )
    LIMIT p_limit
  ),
  claimed AS (
    INSERT INTO public.campaign_email_sends (campaign_id, profile_id, address, status)
    SELECT p_campaign_id, e.profile_id, public.waves_email_for(e.profile_id), 'queued'
    FROM eligible e
    ON CONFLICT (campaign_id, profile_id) DO NOTHING
    RETURNING id, profile_id, address
  )
  SELECT cl.id, cl.address, COALESCE(p.locale, 'en'),
         c.title, c.body, c.cta_label, c.promo_code, c.ends_at
  FROM claimed cl
  JOIN public.profiles p ON p.id = cl.profile_id
  CROSS JOIN c;
END
$$;


--
-- Name: waves_claim_email_notifications(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_claim_email_notifications(p_limit integer DEFAULT 100) RETURNS TABLE(id uuid, kind text, title text, body text, deep_link text, payload jsonb, locale text, address text, group_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ids UUID[];
BEGIN
  WITH picked AS (
    SELECT n.id
    FROM public.notifications n
    WHERE n.email_status IS NULL
      -- Same two days as push — a mail about a reminder from Tuesday is
      -- worse than no mail.
      AND n.created_at > now() - interval '2 days'
      -- `group_added` is a fallback for when push never lands (no in-app
      -- inbox to check instead, #565), not routine mail — the suppression
      -- clause below is what keeps it rare.
      AND n.kind IN ('settlement_initiated', 'settlement_confirm_request', 'digest_daily', 'nudge', 'group_added')
      -- Every other kind on this list is decided the moment it is claimed —
      -- a nudge only ever asks "is there a device", never "did the push
      -- succeed". `group_added` asks the second question, and push can take
      -- several fanout runs to answer it (the retry backoff above). Since
      -- `email_status IS NULL` never lets a row be claimed twice, claiming
      -- it before push is done would decide — wrongly, permanently — before
      -- push had even tried once.
      AND (
        n.kind <> 'group_added'
        OR n.push_status = 'sent'
        OR (n.push_status = 'failed' AND n.push_next_retry_at IS NULL)
      )
    ORDER BY n.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.notifications n
       SET email_status = 'queued'
      FROM picked
     WHERE n.id = picked.id
    RETURNING n.id
  )
  SELECT COALESCE(array_agg(claimed.id), '{}') INTO v_ids FROM claimed;

  -- Separate statements — Postgres will not apply two updates to the same
  -- row inside one statement.

  -- No address, no confirmed address, or email turned off. Not a failure; a
  -- decision, marked as one so it never gets retried.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND (
       public.waves_email_for(n.profile_id) IS NULL
       OR NOT COALESCE(
            (SELECT (p.notification_prefs ->> 'email')::boolean
             FROM public.profiles p WHERE p.id = n.profile_id),
            TRUE
          )
     );

  -- The mailbox already said no, by bouncing, complaining or unsubscribing.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND n.email_status = 'queued'
     AND public.waves_email_suppressed(public.waves_email_for(n.profile_id));

  -- TDR §7.4: a nudge goes by email only to somebody with no live device —
  -- everybody else already got a buzz about it.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND n.email_status = 'queued'
     AND n.kind = 'nudge'
     AND EXISTS (
       SELECT 1 FROM public.push_tokens t
       WHERE t.profile_id = n.profile_id AND t.revoked_at IS NULL
     );

  -- `group_added` suppresses on two different facts, checked in the order
  -- that matters: a push that already succeeded is suppressed outright
  -- (`push_status = 'sent'` cannot change again, unlike whether a device
  -- happens to be live at the moment this runs — checking the token table
  -- first would wrongly re-open a push that already landed). Short of that,
  -- it suppresses exactly like a nudge: a live device and fewer than 3
  -- failed attempts means push might still land, so no mail yet.
  UPDATE public.notifications n
     SET email_status = 'suppressed'
   WHERE n.id = ANY(v_ids)
     AND n.email_status = 'queued'
     AND n.kind = 'group_added'
     AND (
       n.push_status = 'sent'
       OR (
         EXISTS (
           SELECT 1 FROM public.push_tokens t
           WHERE t.profile_id = n.profile_id AND t.revoked_at IS NULL
         )
         AND NOT (n.push_status = 'failed' AND n.push_attempts >= 3)
       )
     );

  RETURN QUERY
  SELECT n.id, n.kind, n.title, n.body, n.deep_link, n.payload,
         COALESCE(p.locale, 'en'),
         public.waves_email_for(n.profile_id),
         g.name
  FROM public.notifications n
  LEFT JOIN public.profiles p ON p.id = n.profile_id
  LEFT JOIN public.groups g ON g.id = n.group_id
  WHERE n.id = ANY(v_ids) AND n.email_status = 'queued';
END
$$;


--
-- Name: waves_claim_push_notifications(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_claim_push_notifications(p_limit integer DEFAULT 200) RETURNS TABLE(id uuid, kind text, title text, body text, deep_link text, payload jsonb, locale text, tokens text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ids UUID[];
BEGIN
  -- `FOR UPDATE SKIP LOCKED` is what lets two runs overlap harmlessly: the
  -- second finds the rows locked and moves on rather than sending them
  -- again. A first try (`push_status IS NULL`) and a retry (`failed`, under
  -- 3 attempts, backoff elapsed) are the same claim, differing only in which
  -- half of the WHERE let the row through.
  WITH picked AS (
    SELECT n.id
    FROM public.notifications n
    WHERE (
            n.push_status IS NULL
         OR (n.push_status = 'failed'
             AND n.push_attempts < 3
             AND n.push_next_retry_at IS NOT NULL
             AND n.push_next_retry_at <= now())
          )
      -- Anything older than this was missed while the fanout was down, and a
      -- buzz about a two-day-old reminder is worse than silence.
      AND n.created_at > now() - interval '2 days'
    ORDER BY n.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.notifications n
       SET push_status = 'queued'
      FROM picked
     WHERE n.id = picked.id
    RETURNING n.id
  )
  SELECT COALESCE(array_agg(claimed.id), '{}') INTO v_ids FROM claimed;

  -- A separate statement: Postgres will not apply two updates to the same
  -- row inside one statement, so folding this into the CTE above would
  -- silently do nothing.
  --
  -- No device is a decision, not a failure — closed out terminally
  -- (`push_next_retry_at` cleared, not just `push_status`) rather than left
  -- retryable, or it would sit in the claim's way on every future run.
  -- `push_attempts` is left alone: a new token showing up later is a
  -- different signal than time passing, and not this branch's business.
  UPDATE public.notifications n
     SET push_status = 'failed',
         push_next_retry_at = NULL
   WHERE n.id = ANY(v_ids)
     AND NOT EXISTS (
       SELECT 1 FROM public.push_tokens t
       WHERE t.profile_id = n.profile_id AND t.revoked_at IS NULL
     );

  RETURN QUERY
  SELECT n.id, n.kind, n.title, n.body, n.deep_link, n.payload,
         COALESCE(p.locale, 'en'),
         ARRAY_AGG(t.expo_push_token)
  FROM public.notifications n
  LEFT JOIN public.profiles p ON p.id = n.profile_id
  JOIN public.push_tokens t
    ON t.profile_id = n.profile_id AND t.revoked_at IS NULL
  WHERE n.id = ANY(v_ids) AND n.push_status = 'queued'
  GROUP BY n.id, n.kind, n.title, n.body, n.deep_link, n.payload, p.locale;
END
$$;


--
-- Name: waves_clear_my_trip_budget(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_clear_my_trip_budget(p_group_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_member uuid;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_member := public.waves_my_member_id(p_group_id);
  UPDATE public.trip_member_budgets
     SET deleted_at = now()
   WHERE group_id = p_group_id AND member_id = v_member AND deleted_at IS NULL;
END
$$;


--
-- Name: waves_close_disputes_on_new_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_close_disputes_on_new_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  UPDATE public.expense_disputes
     SET status = 'resolved',
         resolution_note = 'The expense was edited',
         resolved_at = now(),
         updated_at = now(),
         resolved_by_member_id = NEW.author_member_id
   WHERE expense_id = NEW.expense_id AND status = 'open';
  RETURN NEW;
END
$$;


--
-- Name: waves_confirm_settlement(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_confirm_settlement(p_settlement_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_to       uuid;
  v_actor    uuid;
BEGIN
  SELECT group_id, to_member_id INTO v_group_id, v_to
  FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.waves_my_member_id(v_group_id);
  -- Only the payee confirms receipt. The payer saying "trust me" is exactly
  -- the hole the confirm step exists to close (ADR-007).
  IF v_actor IS NULL OR v_actor <> v_to THEN
    RAISE EXCEPTION 'NOT_THE_PAYEE: only the person who was paid can confirm'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.settlements SET status = 'confirmed' WHERE id = p_settlement_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_actor, 'confirmed', 'settlement', p_settlement_id, '{}'::jsonb);
END
$$;


--
-- Name: waves_consume_invite(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_consume_invite(p_invite_id uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  UPDATE public.invites
  SET use_count = use_count + 1
  WHERE id = p_invite_id
    AND revoked_at IS NULL
    AND expires_at > now()
    AND use_count < max_uses
  RETURNING true;
$$;


--
-- Name: waves_create_group(text, text, character, text, boolean, uuid, text, character, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_create_group(p_name text DEFAULT NULL::text, p_type text DEFAULT 'other'::text, p_currency character DEFAULT 'INR'::bpchar, p_emoji text DEFAULT NULL::text, p_simplify boolean DEFAULT true, p_group_id uuid DEFAULT NULL::uuid, p_photo_path text DEFAULT NULL::text, p_country character DEFAULT NULL::bpchar, p_creator_member_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile_id uuid := public.waves_current_profile_id();
  v_group_id   uuid;
  v_member_id  uuid;
  v_name       text := nullif(btrim(coalesce(p_name, '')), '');
  v_country    char(2) := nullif(btrim(upper(coalesce(p_country, ''))), '');
  v_is_guest   boolean;
  v_created_at timestamptz;
  v_group_count integer;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: a group needs an owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile_id) THEN
    RAISE EXCEPTION 'NO_PROFILE: profile % does not exist', v_profile_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Replaying the create half of a queue must return the same group, not a
  -- second one — and must not let somebody else's id be hijacked (ADR-005).
  -- This runs before the guest check on purpose: replaying the create of the
  -- one group a guest already has must not be mistaken for a second group.
  IF p_group_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.groups WHERE id = p_group_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = p_group_id AND gm.profile_id = v_profile_id AND gm.left_at IS NULL
    ) THEN
      RAISE EXCEPTION 'GROUP_EXISTS: that group id is already taken'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN p_group_id;
  END IF;

  -- Guest ceilings (ADR-006 addendum). Mirrors GUEST_GROUP_LIMIT and
  -- GUEST_TRIAL_DAYS in @waves/core.
  --
  -- Guarded on the real auth.users *with* its `is_anonymous` column: CI runs
  -- these migrations against a stub auth schema whose users table has no such
  -- column, and calls this function to check ledger invariants. The column
  -- reference inside the branch is only planned when the branch actually runs
  -- (plpgsql plans statements lazily), so a false guard here means the missing
  -- column is never touched. Absent an is_anonymous column there are no
  -- anonymous users to limit anyway, so skipping the check is correct, not a
  -- hole.
  IF to_regclass('auth.users') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'auth'
         AND table_name = 'users'
         AND column_name = 'is_anonymous'
     ) THEN
    SELECT u.is_anonymous, u.created_at
      INTO v_is_guest, v_created_at
      FROM auth.users u
      WHERE u.id = v_profile_id;

    IF coalesce(v_is_guest, false) THEN
      IF now() >= v_created_at + interval '10 days' THEN
        RAISE EXCEPTION 'GUEST_TRIAL_EXPIRED: sign up to keep using Waves'
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      SELECT count(*) INTO v_group_count
        FROM public.group_members
        WHERE profile_id = v_profile_id AND left_at IS NULL;

      IF v_group_count >= 1 THEN
        RAISE EXCEPTION 'GUEST_GROUP_LIMIT: sign up to be in more than one group'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.groups
    (id, name, type, default_currency, cover_emoji, simplify_debts, created_by, photo_path,
     country_code)
  VALUES
    (COALESCE(p_group_id, gen_random_uuid()), v_name, p_type::"GroupType",
     upper(p_currency), p_emoji, p_simplify, v_profile_id, p_photo_path,
     COALESCE(v_country, (SELECT country_code FROM public.profiles WHERE id = v_profile_id)))
  RETURNING id INTO v_group_id;

  -- The creator's membership takes the client's id when one was given, so a
  -- queued expense made in the same offline breath can already name it; else the
  -- server mints one as before.
  INSERT INTO public.group_members (id, group_id, profile_id, role, joined_via)
  VALUES (COALESCE(p_creator_member_id, gen_random_uuid()), v_group_id, v_profile_id, 'admin', 'creator')
  RETURNING id INTO v_member_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'created', 'group', v_group_id,
          jsonb_build_object('name', v_name));

  RETURN v_group_id;
END
$$;


--
-- Name: waves_current_profile_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_current_profile_id() RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT NULLIF(
    COALESCE(
      current_setting('request.jwt.claim.sub', true),
      (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;


--
-- Name: waves_decide_member_claim(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_decide_member_claim(p_claim_id uuid, p_approve boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile   uuid := public.waves_current_profile_id();
  v_claim     public.member_claims%ROWTYPE;
  v_admin_id  uuid;
  v_group     text;
  v_ghost     text;
  v_moved     integer;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;

  SELECT * INTO v_claim FROM public.member_claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NO_SUCH_CLAIM');
  END IF;

  SELECT id INTO v_admin_id
    FROM public.group_members
   WHERE group_id = v_claim.group_id
     AND profile_id = v_profile
     AND role = 'admin'
     AND left_at IS NULL;

  -- Not an admin of this group. The same answer as a claim that does not
  -- exist, so this cannot be used to find out which claims do.
  IF v_admin_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NO_SUCH_CLAIM');
  END IF;

  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_DECIDED', 'status', v_claim.status);
  END IF;

  SELECT name INTO v_group FROM public.groups WHERE id = v_claim.group_id;
  SELECT ghost_name INTO v_ghost FROM public.group_members WHERE id = v_claim.member_id;

  IF NOT p_approve THEN
    UPDATE public.member_claims
       SET status = 'declined', decided_by = v_admin_id, decided_at = now()
     WHERE id = p_claim_id;

    PERFORM public.waves_notify(
      v_claim.requester_id,
      v_claim.group_id,
      'ghost_claim_declined',
      'Not confirmed',
      COALESCE(v_group, 'The group') || ' did not confirm that place. You can still join as yourself.',
      '/join',
      jsonb_build_object('claim_id', p_claim_id, 'group_name', v_group),
      'claim_declined:' || p_claim_id::text
    );

    RETURN jsonb_build_object('ok', true, 'status', 'declined');
  END IF;

  -- Somebody who joined by another route while this sat waiting must not end
  -- up as two members of one group.
  IF EXISTS (
    SELECT 1 FROM public.group_members
     WHERE group_id = v_claim.group_id
       AND profile_id = v_claim.requester_id
       AND left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_A_MEMBER');
  END IF;

  UPDATE public.group_members
     SET profile_id = v_claim.requester_id,
         ghost_name = NULL,
         joined_via = 'invite_link_claim'
   WHERE id = v_claim.member_id
     AND profile_id IS NULL
     AND left_at IS NULL;

  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NOT_CLAIMABLE');
  END IF;

  -- The name they gave, written only now. `invite-accept` used to set it while
  -- claiming, which meant an unconfirmed stranger could rename their own
  -- profile through a join request. And only over the placeholder: somebody
  -- who named themselves two years ago must not be renamed by a group they
  -- have just joined.
  IF v_claim.requested_name IS NOT NULL THEN
    UPDATE public.profiles
       SET display_name = v_claim.requested_name
     WHERE id = v_claim.requester_id
       AND (display_name IS NULL OR display_name = '' OR display_name = 'Guest');
  END IF;

  UPDATE public.member_claims
     SET status = 'approved', decided_by = v_admin_id, decided_at = now()
   WHERE id = p_claim_id;

  -- Anybody else waiting on the same place has lost it. Leaving them pending
  -- would mean an admin later approving a claim on a member who now belongs to
  -- somebody, and being told NOT_CLAIMABLE with no idea why.
  UPDATE public.member_claims
     SET status = 'declined', decided_by = v_admin_id, decided_at = now()
   WHERE member_id = v_claim.member_id
     AND status = 'pending'
     AND id <> p_claim_id;

  PERFORM public.waves_notify(
    v_claim.requester_id,
    v_claim.group_id,
    'ghost_claim_approved',
    'You are in ' || COALESCE(v_group, 'the group'),
    'Everything already filed under ' || COALESCE(v_ghost, 'that name') || ' is yours',
    '/group/' || v_claim.group_id::text,
    jsonb_build_object('claim_id', p_claim_id, 'group_name', v_group, 'ghost_name', v_ghost),
    'claim_approved:' || p_claim_id::text
  );

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    v_claim.group_id,
    v_claim.member_id,
    'claimed',
    'member',
    v_claim.member_id,
    jsonb_build_object('via', 'invite_link', 'confirmed_by', v_admin_id)
  );

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'member_id', v_claim.member_id);
END
$$;


--
-- Name: waves_delete_expense(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_delete_expense(p_expense_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id  uuid;
  v_member_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in this group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_member_id := public.waves_my_member_id(v_group_id);

  UPDATE public.expenses
     SET deleted_at = now(), deleted_by = v_member_id
   WHERE id = p_expense_id AND deleted_at IS NULL;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'deleted', 'expense', p_expense_id, '{}'::jsonb);
END
$$;


--
-- Name: waves_delete_expense_comment(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_delete_expense_comment(p_comment_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_author   uuid;
  v_me       uuid;
BEGIN
  SELECT group_id, author_member_id INTO v_group_id, v_author
    FROM public.expense_comments WHERE id = p_comment_id;
  IF v_group_id IS NULL THEN
    RETURN; -- Never existed. Removing nothing is not an error.
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_me := public.waves_my_member_id(v_group_id);
  -- Own comment, or an admin reaching for anyone's. Nothing else.
  IF NOT (v_author = v_me OR public.is_group_admin(v_group_id)) THEN
    RAISE EXCEPTION 'CANNOT_DELETE: only the author or an admin can delete this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_comments
     SET deleted_at = now(), deleted_by = v_me
   WHERE id = p_comment_id AND deleted_at IS NULL;
END
$$;


--
-- Name: waves_delete_group(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_delete_group(p_group_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile_id uuid := public.waves_current_profile_id();
  v_deleted_at timestamptz;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in to delete a group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Lock the group row up front (FOR UPDATE), before the settled check, so the
  -- settlement validation and the tombstone that follows read and write the same
  -- serialized view of the row. This closes the delete-vs-delete window and gives
  -- a single coordination point a balance-mutating writer can share (take the
  -- same row lock) to be serialized against a delete; on its own it does not stop
  -- a writer that never locks this row (see A49 review notes).
  SELECT deleted_at INTO v_deleted_at FROM public.groups WHERE id = p_group_id FOR UPDATE;
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
  -- `waves_group_balances_truth` returns only non-zero rows (ADR-004), so any row
  -- at all means somebody is still owed and the group cannot be pulled out from
  -- under them. Same source `waves_refresh_group_balances` derives from, so this
  -- never disagrees with the stored balances.
  IF EXISTS (SELECT 1 FROM public.waves_group_balances_truth(p_group_id)) THEN
    RAISE EXCEPTION 'NOT_SETTLED: settle every balance before deleting the group'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The tombstone. The stamp trigger bumps `updated_seq`, so the change reaches
  -- every member's mirror on their next sync and the group leaves all their lists.
  UPDATE public.groups SET deleted_at = now() WHERE id = p_group_id;
END
$$;


--
-- Name: waves_delete_my_account(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_delete_my_account(p_feedback text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
  v_memberships integer;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;

  -- While there is still an author to attribute it to. It outlives the row.
  IF length(trim(COALESCE(p_feedback, ''))) > 0 THEN
    PERFORM public.waves_submit_feedback(p_feedback, 'deletion');
  END IF;

  -- Both columns in one UPDATE: the XOR check is evaluated per row, so setting
  -- them in two statements is not possible even inside a transaction.
  UPDATE public.group_members
     SET profile_id = NULL,
         ghost_name = 'Former member',
         payment_handle = NULL,
         payment_rail = NULL,
         vpa = NULL,
         invite_email = NULL,
         invite_phone = NULL
   WHERE profile_id = v_profile;
  GET DIAGNOSTICS v_memberships = ROW_COUNT;

  DELETE FROM public.profiles WHERE id = v_profile;

  RETURN jsonb_build_object(
    'ok', true,
    'memberships_anonymised', v_memberships
  );
END
$$;


--
-- Name: waves_device_cap(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_device_cap(p_profile_id uuid, p_is_plus boolean) RETURNS integer
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  v_knob_key text := CASE WHEN p_is_plus THEN 'device_cap_plus' ELSE 'device_cap_free' END;
  v_flag_key text := CASE WHEN p_is_plus THEN 'device_cap_plus_ab' ELSE 'device_cap_free_ab' END;
  v_floor    int  := CASE WHEN p_is_plus THEN 3 ELSE 2 END;
  v_arm      text;
BEGIN
  IF p_profile_id IS NOT NULL THEN
    v_arm := public.waves_variant(v_flag_key, p_profile_id);
    IF v_arm ~ '^[0-9]+$' THEN
      RETURN v_arm::int;
    END IF;
  END IF;

  RETURN COALESCE((SELECT value FROM public.app_config WHERE key = v_knob_key), v_floor);
END
$_$;


--
-- Name: waves_dispute_expense(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_dispute_expense(p_expense_id uuid, p_reason text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id     UUID;
  v_actor        UUID;
  v_dispute_id   UUID;
  v_raised_at    TIMESTAMPTZ;
  v_author       UUID;
  v_author_pid   UUID;
  v_description  TEXT;
  v_group_name   TEXT;
  v_actor_name   TEXT;
BEGIN
  SELECT e.group_id, v.author_member_id, v.description
    INTO v_group_id, v_author, v_description
  FROM public.expenses e
  LEFT JOIN public.expense_versions v ON v.id = e.current_version_id
  WHERE e.id = p_expense_id AND e.deleted_at IS NULL;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.waves_my_member_id(v_group_id);
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: only a member of the group can dispute its expenses'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Re-raising replaces the previous position rather than stacking another row.
  --
  -- `updated_at` moves only when something actually changed. Calling this twice
  -- with the same complaint is a retry and must be silent; raising it again
  -- after it was rejected is a new complaint and must not be.
  INSERT INTO public.expense_disputes AS d (expense_id, member_id, reason, status)
  VALUES (p_expense_id, v_actor, NULLIF(btrim(p_reason), ''), 'open')
  ON CONFLICT (expense_id, member_id) DO UPDATE
    SET reason = EXCLUDED.reason,
        status = 'open',
        resolved_by_member_id = NULL,
        resolution_note = NULL,
        resolved_at = NULL,
        updated_at = CASE
          WHEN d.status = 'open' AND d.reason IS NOT DISTINCT FROM EXCLUDED.reason
          THEN d.updated_at
          ELSE now()
        END
  RETURNING d.id, d.updated_at INTO v_dispute_id, v_raised_at;

  SELECT COALESCE(p.display_name, m.ghost_name) INTO v_actor_name
  FROM public.group_members m
  LEFT JOIN public.profiles p ON p.id = m.profile_id
  WHERE m.id = v_actor;

  SELECT name INTO v_group_name FROM public.groups WHERE id = v_group_id;

  INSERT INTO public.activity_log
    (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES
    (v_group_id, v_actor, 'disputed', 'expense', p_expense_id,
     jsonb_build_object('description', v_description, 'reason', NULLIF(btrim(p_reason), '')));

  -- The person who entered it is the person who can fix it.
  SELECT profile_id INTO v_author_pid FROM public.group_members WHERE id = v_author;
  IF v_author_pid IS NOT NULL AND v_author IS DISTINCT FROM v_actor THEN
    PERFORM public.waves_notify(
      v_author_pid, v_group_id, 'expense_disputed',
      COALESCE(v_actor_name, 'Someone') || ' says an expense is wrong',
      COALESCE(v_description, 'An expense') || ' — have a look',
      'waves://group/' || v_group_id::text || '/expense/' || p_expense_id::text,
      jsonb_build_object('counterparty', v_actor_name, 'group', v_group_name,
                         'description', v_description, 'expenseId', p_expense_id),
      'dispute:' || v_dispute_id::text || ':raised:' || v_raised_at::text
    );
  END IF;

  RETURN v_dispute_id;
END
$$;


--
-- Name: waves_dispute_settlement(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_dispute_settlement(p_settlement_id uuid, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_to       uuid;
  v_status   public."SettlementStatus";
  v_actor    uuid;
BEGIN
  SELECT group_id, to_member_id, status INTO v_group_id, v_to, v_status
  FROM public.settlements WHERE id = p_settlement_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such settlement' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.waves_my_member_id(v_group_id);
  -- Only the payee disputes: disputing is saying "the money never reached me",
  -- which only the person who was supposed to receive it can honestly claim.
  IF v_actor IS NULL OR v_actor <> v_to THEN
    RAISE EXCEPTION 'NOT_THE_PAYEE: only the person who was paid can dispute this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_status = 'disputed' THEN
    RETURN;  -- idempotent replay
  END IF;

  -- The trigger permits initiated/auto_confirmed → disputed; a manually
  -- confirmed or already-cancelled row is out of reach.
  IF v_status NOT IN ('initiated', 'auto_confirmed') THEN
    RAISE EXCEPTION 'NOT_DISPUTABLE: this settlement can no longer be disputed'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.settlements SET status = 'disputed' WHERE id = p_settlement_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    v_group_id, v_actor, 'settle_disputed', 'settlement', p_settlement_id,
    CASE WHEN p_reason IS NULL OR btrim(p_reason) = ''
         THEN '{}'::jsonb
         ELSE jsonb_build_object('reason', btrim(p_reason)) END
  );
END
$$;


--
-- Name: waves_edit_expense_comment(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_edit_expense_comment(p_comment_id uuid, p_body text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_author   uuid;
  v_body     text := btrim(COALESCE(p_body, ''));
BEGIN
  SELECT group_id, author_member_id INTO v_group_id, v_author
    FROM public.expense_comments
   WHERE id = p_comment_id AND deleted_at IS NULL;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_COMMENT: no such comment'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_author IS NULL OR v_author <> public.waves_my_member_id(v_group_id) THEN
    RAISE EXCEPTION 'NOT_YOUR_COMMENT: you can only edit your own'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_body = '' THEN
    RAISE EXCEPTION 'EMPTY_COMMENT: a comment needs some text'
      USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'COMMENT_TOO_LONG: keep it under 2000 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.expense_comments
     SET body = v_body, edited_at = now()
   WHERE id = p_comment_id AND deleted_at IS NULL;
END
$$;


--
-- Name: waves_email_for(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_email_for(p_profile_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  v_email text;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE $q$
    SELECT lower(u.email)
    FROM auth.users u
    WHERE u.id = $1
      AND u.email IS NOT NULL
      AND u.email <> ''
      AND u.email_confirmed_at IS NOT NULL
  $q$
  INTO v_email
  USING p_profile_id;

  RETURN v_email;
END
$_$;


--
-- Name: waves_email_suppressed(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_email_suppressed(p_address text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_suppressions
    WHERE address = lower(trim(COALESCE(p_address, '')))
  );
$$;


--
-- Name: waves_ensure_group_join_token(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_ensure_group_join_token(p_group_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_token text;
  v_live  boolean;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT join_token INTO v_token FROM public.groups WHERE id = p_group_id;
  IF v_token IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.invites
       WHERE group_id = p_group_id
         AND token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex')
         AND revoked_at IS NULL
         AND expires_at > now()
         AND use_count < max_uses
    ) INTO v_live;
    IF v_live THEN
      RETURN v_token;
    END IF;
  END IF;

  RETURN public.waves_new_group_join_token(p_group_id, false);
END
$$;


--
-- Name: waves_expense_restore_window(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_expense_restore_window() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL
     AND NEW.deleted_at IS NULL
     AND OLD.deleted_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'RESTORE_WINDOW_EXPIRED: this expense was deleted more than 30 days ago'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: waves_finish_campaign_emails(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_finish_campaign_emails(p_results jsonb DEFAULT '[]'::jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_row    jsonb;
  v_id     uuid;
  v_status text;
  v_count  integer := 0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_results, '[]'::jsonb))
  LOOP
    v_id := (v_row ->> 'id')::uuid;
    v_status := COALESCE(v_row ->> 'status', 'failed');

    IF v_status = 'retry' THEN
      DELETE FROM public.campaign_email_sends WHERE id = v_id;
    ELSIF v_status = 'sent' THEN
      UPDATE public.campaign_email_sends
         SET status = 'sent',
             resend_email_id = v_row ->> 'resend_email_id',
             error = NULL,
             updated_at = now()
       WHERE id = v_id;

      INSERT INTO public.email_events
        (notification_id, profile_id, resend_email_id, template, event, payload)
      SELECT NULL, s.profile_id, v_row ->> 'resend_email_id', 'campaign', 'sent', '{}'::jsonb
      FROM public.campaign_email_sends s
      WHERE s.id = v_id;
    ELSE
      UPDATE public.campaign_email_sends
         SET status = 'failed',
             error = v_row ->> 'error',
             updated_at = now()
       WHERE id = v_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;


--
-- Name: waves_finish_email(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_finish_email(p_results jsonb DEFAULT '[]'::jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_row     jsonb;
  v_id      uuid;
  v_status  text;
  v_count   integer := 0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_results, '[]'::jsonb))
  LOOP
    v_id := (v_row ->> 'id')::uuid;
    v_status := COALESCE(v_row ->> 'status', 'failed');
    IF v_status NOT IN ('sent', 'failed', 'retry') THEN
      v_status := 'failed';
    END IF;

    IF v_status = 'retry' THEN
      -- Back to unclaimed. Resend being rate-limited or briefly down is not a
      -- reason to lose a settlement confirmation; the next run picks it up, and
      -- the two-day window in the claim is what stops it retrying forever.
      UPDATE public.notifications SET email_status = NULL WHERE id = v_id;
    ELSE
      UPDATE public.notifications
         SET email_status = v_status::public."DeliveryStatus"
       WHERE id = v_id;
    END IF;

    -- The send itself is an event. Without this row the webhook has nothing to
    -- match its `delivered` and `bounced` reports against — Resend reports an
    -- email id, and this is the only place that id is ever written down.
    IF v_status = 'sent' THEN
      INSERT INTO public.email_events
        (notification_id, profile_id, resend_email_id, template, event, payload)
      SELECT n.id, n.profile_id, v_row ->> 'resend_email_id',
             COALESCE(v_row ->> 'template', 'unknown'), 'sent', '{}'::jsonb
      FROM public.notifications n
      WHERE n.id = v_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;


--
-- Name: waves_finish_push(uuid[], uuid[], text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_finish_push(p_delivered uuid[] DEFAULT '{}'::uuid[], p_failed uuid[] DEFAULT '{}'::uuid[], p_revoke text[] DEFAULT '{}'::text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- 'sent' rather than 'delivered': Expo accepting a message is as much as
  -- this layer can know. `push_next_retry_at` is cleared alongside it — a
  -- terminal row should not still carry scheduling metadata for a retry
  -- that will never run.
  UPDATE public.notifications
     SET push_status = 'sent',
         push_next_retry_at = NULL
   WHERE id = ANY(p_delivered);

  -- A failure counts itself and, under 3 attempts, schedules the next one —
  -- 3 minutes after the first, 9 after the second. The third leaves
  -- `push_next_retry_at` null: `push_attempts < 3` alone would still be true
  -- at attempt 3, so the claim above needs this to know there is no fourth
  -- try coming.
  UPDATE public.notifications
     SET push_status = 'failed',
         push_attempts = push_attempts + 1,
         push_next_retry_at = CASE
           WHEN push_attempts + 1 < 3
             THEN now() + (power(3, push_attempts + 1) * interval '1 minute')
           ELSE NULL
         END
   WHERE id = ANY(p_failed);

  -- Soft, not deleted: the row is evidence of a device that existed, and the
  -- same token coming back later is a reinstall rather than a new device.
  UPDATE public.push_tokens
     SET revoked_at = now()
   WHERE expo_push_token = ANY(p_revoke) AND revoked_at IS NULL;
END
$$;


--
-- Name: waves_flag_expense_comment(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_flag_expense_comment(p_comment_id uuid, p_flag boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id
    FROM public.expense_comments WHERE id = p_comment_id AND deleted_at IS NULL;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_COMMENT: no such comment'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_flag THEN
    -- Any member reports; keep the first flagger (WHERE flagged_at IS NULL).
    UPDATE public.expense_comments
       SET flagged_at = now(), flagged_by = public.waves_my_member_id(v_group_id)
     WHERE id = p_comment_id AND deleted_at IS NULL AND flagged_at IS NULL;
  ELSE
    -- Only an admin resolves a report.
    IF NOT public.is_group_admin(v_group_id) THEN
      RAISE EXCEPTION 'ADMIN_ONLY: only an admin can clear a flag'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE public.expense_comments
       SET flagged_at = NULL, flagged_by = NULL
     WHERE id = p_comment_id AND deleted_at IS NULL;
  END IF;
END
$$;


--
-- Name: waves_forbid_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION
    'APPEND_ONLY: % rows cannot be % (ADR-004). Insert a new version or set deleted_at.',
    TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END
$$;


--
-- Name: waves_free_storage_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_free_storage_cap() RETURNS bigint
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT COALESCE(
    (SELECT value FROM public.app_config WHERE key = 'free_storage_cap_bytes'),
    10485760
  )::bigint;
$$;


--
-- Name: waves_grant_promo(uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_grant_promo(p_profile_id uuid, p_days integer, p_source text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.subscriptions
    (profile_id, tier, period, status, current_period_end, store, store_txn_id)
  VALUES (
    p_profile_id,
    'plus',
    'monthly',
    'active',
    now() + make_interval(days => p_days),
    'promo',
    p_source
  )
  ON CONFLICT (store_txn_id) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_gravatar_url(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_gravatar_url(p_email text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT CASE
    WHEN p_email IS NULL OR btrim(p_email) = '' THEN NULL
    ELSE 'https://www.gravatar.com/avatar/' || md5(lower(btrim(p_email))) || '?d=404&s=200'
  END
$$;


--
-- Name: waves_group_balances_truth(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_group_balances_truth(p_group_id uuid) RETURNS TABLE(member_id uuid, currency character, balance bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH live_versions AS (
    SELECT ev.id, ev.currency
    FROM public.expense_versions ev
    JOIN public.expenses e
      ON e.id = ev.expense_id
     AND e.current_version_id = ev.id
     AND e.deleted_at IS NULL
    WHERE e.group_id = p_group_id
  ),
  movements AS (
    SELECT p.member_id, lv.currency, p.amount AS delta
      FROM public.expense_payers p JOIN live_versions lv ON lv.id = p.expense_version_id
    UNION ALL
    SELECT s.member_id, lv.currency, -s.amount
      FROM public.expense_shares s JOIN live_versions lv ON lv.id = s.expense_version_id
    UNION ALL
    SELECT st.from_member_id, st.currency, st.amount
      FROM public.settlements st
     WHERE st.group_id = p_group_id AND st.status IN ('confirmed', 'auto_confirmed')
    UNION ALL
    SELECT st.to_member_id, st.currency, -st.amount
      FROM public.settlements st
     WHERE st.group_id = p_group_id AND st.status IN ('confirmed', 'auto_confirmed')
  )
  SELECT member_id, currency, SUM(delta)::bigint AS balance
  FROM movements
  GROUP BY member_id, currency
  HAVING SUM(delta) <> 0
$$;


--
-- Name: waves_group_from_storage_path(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_group_from_storage_path(p_path text) RETURNS uuid
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $_$
  -- Objects are stored as "<group id>/cover.jpg". Anything that is not a UUID
  -- in the first segment returns NULL, which fails every policy below rather
  -- than raising — a malformed path is a denial, not an error.
  SELECT CASE
    WHEN split_part(p_path, '/', 1) ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(p_path, '/', 1)::uuid
  END
$_$;


--
-- Name: waves_group_is_paid(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_group_is_paid(p_group_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.left_at IS NULL
       AND gm.profile_id IS NOT NULL
       AND public.waves_profile_is_paid(gm.profile_id)
  ) OR EXISTS (
    SELECT 1 FROM public.group_passes gp
     WHERE gp.group_id = p_group_id
       AND gp.expires_at > now()
  );
$$;


--
-- Name: waves_group_member_claims(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_group_member_claims(p_group_id uuid) RETURNS TABLE(id uuid, member_id uuid, ghost_name text, requester_name text, requested_name text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT c.id,
         c.member_id,
         m.ghost_name,
         p.display_name,
         c.requested_name,
         c.created_at
    FROM public.member_claims c
    JOIN public.group_members m ON m.id = c.member_id
    JOIN public.profiles p      ON p.id = c.requester_id
   WHERE c.group_id = p_group_id
     AND c.status = 'pending'
     AND EXISTS (
       SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = p_group_id
          AND gm.profile_id = public.waves_current_profile_id()
          AND gm.role = 'admin'
          AND gm.left_at IS NULL
     )
   ORDER BY c.created_at;
$$;


--
-- Name: waves_group_pairwise_truth(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_group_pairwise_truth(p_group_id uuid) RETURNS TABLE(from_member_id uuid, to_member_id uuid, currency character, amount bigint)
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
#variable_conflict use_column
DECLARE
  v_version   RECORD;
  v_debtor_ids   uuid[];
  v_debtor_amts  bigint[];
  v_credit_ids   uuid[];
  v_credit_amts  bigint[];
  d int; c int;
  v_take bigint;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS waves_pairwise_scratch (
    a uuid, b uuid, cur char(3), amt bigint
  ) ON COMMIT DROP;
  DELETE FROM waves_pairwise_scratch WHERE true;

  FOR v_version IN
    SELECT ev.id, ev.currency
    FROM public.expense_versions ev
    JOIN public.expenses e
      ON e.id = ev.expense_id
     AND e.current_version_id = ev.id
     AND e.deleted_at IS NULL
    WHERE e.group_id = p_group_id
  LOOP
    SELECT array_agg(member_id ORDER BY member_id), array_agg(-net ORDER BY member_id)
      INTO v_debtor_ids, v_debtor_amts
    FROM (
      SELECT member_id, SUM(delta)::bigint AS net
      FROM (
        SELECT member_id, amount AS delta FROM public.expense_payers
         WHERE expense_version_id = v_version.id
        UNION ALL
        SELECT member_id, -amount FROM public.expense_shares
         WHERE expense_version_id = v_version.id
      ) m GROUP BY member_id HAVING SUM(delta) < 0
    ) debtors;

    SELECT array_agg(member_id ORDER BY member_id), array_agg(net ORDER BY member_id)
      INTO v_credit_ids, v_credit_amts
    FROM (
      SELECT member_id, SUM(delta)::bigint AS net
      FROM (
        SELECT member_id, amount AS delta FROM public.expense_payers
         WHERE expense_version_id = v_version.id
        UNION ALL
        SELECT member_id, -amount FROM public.expense_shares
         WHERE expense_version_id = v_version.id
      ) m GROUP BY member_id HAVING SUM(delta) > 0
    ) creditors;

    IF v_debtor_ids IS NULL OR v_credit_ids IS NULL THEN
      CONTINUE;
    END IF;

    d := 1; c := 1;
    WHILE d <= array_length(v_debtor_ids, 1) AND c <= array_length(v_credit_ids, 1) LOOP
      v_take := LEAST(v_debtor_amts[d], v_credit_amts[c]);
      IF v_take > 0 THEN
        INSERT INTO waves_pairwise_scratch
        VALUES (v_debtor_ids[d], v_credit_ids[c], v_version.currency, v_take);
        v_debtor_amts[d] := v_debtor_amts[d] - v_take;
        v_credit_amts[c] := v_credit_amts[c] - v_take;
      END IF;
      IF v_debtor_amts[d] = 0 THEN d := d + 1; END IF;
      IF v_credit_amts[c] = 0 THEN c := c + 1; END IF;
    END LOOP;
  END LOOP;

  -- Settlements pay debt down: `from` paying `to` cancels what `from` owes `to`.
  INSERT INTO waves_pairwise_scratch
  SELECT st.to_member_id, st.from_member_id, st.currency, -st.amount
  FROM public.settlements st
  WHERE st.group_id = p_group_id AND st.status IN ('confirmed', 'auto_confirmed');

  RETURN QUERY
  WITH canonical AS (
    SELECT
      LEAST(a, b) AS lo,
      GREATEST(a, b) AS hi,
      cur,
      SUM(CASE WHEN a < b THEN amt ELSE -amt END)::bigint AS net
    FROM waves_pairwise_scratch
    GROUP BY 1, 2, 3
  )
  SELECT
    CASE WHEN net > 0 THEN lo ELSE hi END,
    CASE WHEN net > 0 THEN hi ELSE lo END,
    cur,
    abs(net)::bigint
  FROM canonical
  WHERE net <> 0;
END
$$;


--
-- Name: waves_group_plan(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_group_plan(p_group_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_mine    jsonb := public.waves_my_plan();
  v_expires timestamptz;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_mine ->> 'tier' = 'plus' THEN
    RETURN v_mine;
  END IF;

  SELECT max(expires_at) INTO v_expires
  FROM public.group_passes
  WHERE group_id = p_group_id AND expires_at > now();

  IF v_expires IS NULL THEN
    RETURN v_mine;
  END IF;

  RETURN jsonb_build_object(
    'tier', 'plus', 'until', v_expires, 'source', 'trip_pass', 'scanLimit', 300
  );
END
$$;


--
-- Name: waves_group_spending(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_group_spending(p_group_id uuid) RETURNS TABLE(member_id uuid, currency character, category text, month date, share_amount bigint, expense_count integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH live_versions AS (
    SELECT ev.id, ev.currency, ev.expense_date, ev.category, e.id AS expense_id
    FROM public.expense_versions ev
    JOIN public.expenses e
      ON e.id = ev.expense_id
     AND e.current_version_id = ev.id
     AND e.deleted_at IS NULL
    WHERE e.group_id = p_group_id
  )
  SELECT
    s.member_id,
    lv.currency,
    COALESCE(NULLIF(btrim(lower(lv.category)), ''), 'other') AS category,
    date_trunc('month', lv.expense_date)::date               AS month,
    SUM(s.amount)::bigint                                    AS share_amount,
    COUNT(DISTINCT lv.expense_id)::int                       AS expense_count
  FROM public.expense_shares s
  JOIN live_versions lv ON lv.id = s.expense_version_id
  GROUP BY 1, 2, 3, 4
$$;


--
-- Name: FUNCTION waves_group_spending(p_group_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.waves_group_spending(p_group_id uuid) IS 'M5 analytics (TDR §8): per-member, per-category, per-month spending for one group, in minor units, one row per currency.';


--
-- Name: waves_guard_group_columns(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_guard_group_columns() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.updated_seq IS DISTINCT FROM OLD.updated_seq THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: updated_seq is set by the server, not the client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s creator is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s id is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a group''s creation time is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.photo_path IS DISTINCT FROM OLD.photo_path
     AND NEW.photo_path IS NOT NULL
     AND NOT public.waves_can_upload_group_photo(NEW.id) THEN
    RAISE EXCEPTION 'PHOTO_GATE: a group photo is a paid feature'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.category_budgets IS DISTINCT FROM OLD.category_budgets THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: category budgets are set through waves_set_category_budget, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.fx_rates IS DISTINCT FROM OLD.fx_rates THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: trip rates are set through waves_set_group_fx_rate, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.join_token IS DISTINCT FROM OLD.join_token THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: the join link is set through waves_ensure_group_join_token / waves_reset_group_join_token, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: waves_guard_membership_columns(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_guard_membership_columns() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a role is not yours to change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a ghost is claimed by an admin approving a request, not by an update'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: a membership cannot move between groups'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: waves_handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url, locale)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(NEW.raw_user_meta_data ->> 'display_name', ''),
      NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''),
      NULLIF(NEW.raw_user_meta_data ->> 'name', ''),
      -- ADR-006: anonymous guests get an account too, just an unnamed one.
      'Guest'
    ),
    NEW.raw_user_meta_data ->> 'avatar_url',
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'locale', ''), 'en')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;


--
-- Name: waves_import_ledger(uuid, jsonb, jsonb, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb DEFAULT '[]'::jsonb, p_origin text DEFAULT 'splitwise'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile_id  uuid := public.waves_current_profile_id();
  v_author      uuid;
  v_person      jsonb;
  v_expense     jsonb;
  v_settlement  jsonb;
  v_name        text;
  v_member      uuid;
  v_names       jsonb := '{}'::jsonb;   -- name -> member id, as text
  v_payers      jsonb;
  v_shares      jsonb;
  v_entry       record;
  v_created     int := 0;
  v_ghosts      int := 0;
  v_settled     int := 0;
  v_pending     int := 0;
  v_mutation    uuid;
  v_result      jsonb;
  v_from        uuid;
  v_to          uuid;
  v_from_real   boolean;
  v_to_real     boolean;
  v_file_status text;
  v_status      "SettlementStatus";
  v_at          timestamptz;
BEGIN
  IF v_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.profile_id = v_profile_id AND gm.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_author := public.waves_my_member_id_for(p_group_id, v_profile_id);

  IF jsonb_typeof(p_people) <> 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'NO_PEOPLE: the import named nobody' USING ERRCODE = 'check_violation';
  END IF;

  -- Resolve every name to a member of this group up front, so an unmappable
  -- one fails before a single row is written.
  FOR v_person IN SELECT * FROM jsonb_array_elements(p_people) LOOP
    v_name := btrim(COALESCE(v_person ->> 'name', ''));
    IF v_name = '' THEN
      RAISE EXCEPTION 'NO_PEOPLE: somebody in the file has no name'
        USING ERRCODE = 'check_violation';
    END IF;

    IF (v_person ->> 'memberId') IS NOT NULL THEN
      SELECT gm.id INTO v_member
        FROM public.group_members gm
       WHERE gm.id = (v_person ->> 'memberId')::uuid AND gm.group_id = p_group_id;
      IF v_member IS NULL THEN
        RAISE EXCEPTION 'UNKNOWN_MEMBER: % is not in this group', v_name
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    ELSE
      INSERT INTO public.group_members (group_id, ghost_name, joined_via)
      VALUES (p_group_id, v_name, 'ghost')
      RETURNING id INTO v_member;
      v_ghosts := v_ghosts + 1;
    END IF;

    v_names := v_names || jsonb_build_object(v_name, v_member::text);
  END LOOP;

  FOR v_expense IN SELECT * FROM jsonb_array_elements(p_expenses) LOOP
    -- Names become member ids here rather than on the client, so the client
    -- never gets to choose which member a row lands on.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'memberId', v_names ->> entry.key,
             'amount',   entry.value #>> '{}'
           )), '[]'::jsonb)
      INTO v_payers
      FROM jsonb_each(v_expense -> 'payers') AS entry;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'memberId', v_names ->> entry.key,
             'amount',   entry.value #>> '{}'
           )), '[]'::jsonb)
      INTO v_shares
      FROM jsonb_each(v_expense -> 'shares') AS entry;

    FOR v_entry IN
      SELECT key FROM jsonb_each(v_expense -> 'shares')
      UNION
      SELECT key FROM jsonb_each(v_expense -> 'payers')
    LOOP
      IF (v_names ->> v_entry.key) IS NULL THEN
        RAISE EXCEPTION 'UNKNOWN_MEMBER: "%" appears in an expense but not in the people list',
          v_entry.key USING ERRCODE = 'foreign_key_violation';
      END IF;
    END LOOP;

    v_result := public.waves_apply_expense(
      p_group_id           => p_group_id,
      p_expense_id         => NULL,
      p_author_member_id   => v_author,
      p_description        => COALESCE(v_expense ->> 'description', 'Imported expense'),
      p_category           => v_expense ->> 'category',
      p_expense_date       => (v_expense ->> 'date')::date,
      p_currency           => upper(COALESCE(v_expense ->> 'currency', 'INR'))::char(3),
      p_amount             => (v_expense ->> 'amount')::bigint,
      -- 'exact' regardless of how the split was originally expressed: the
      -- participants are new members with new ids, so a percentage or a set of
      -- weights would have to be re-divided and could land a paisa somewhere
      -- the file did not. The amounts are the amounts — and with an exact
      -- split the shares ARE the split params, so there is nothing for the
      -- server to recompute; `waves_check_expense_totals` still refuses a
      -- version whose payers or shares do not sum to the amount.
      p_split_type         => 'exact',
      p_split_params       => jsonb_build_object('kind', 'exact', 'amounts', (
        SELECT COALESCE(jsonb_object_agg(v_names ->> entry.key, entry.value), '{}'::jsonb)
          FROM jsonb_each(v_expense -> 'shares') AS entry
      )),
      p_payers             => v_payers,
      p_shares             => v_shares,
      p_client_mutation_id => (v_expense ->> 'clientMutationId')::uuid,
      p_source             => 'imported'
    );

    -- A replayed row is one this import already wrote — a second tap, or a lost
    -- response. Not an error, and not a second copy either (ADR-005).
    IF COALESCE((v_result ->> 'replayed')::boolean, false) = false THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;

  FOR v_settlement IN SELECT * FROM jsonb_array_elements(p_settlements) LOOP
    IF (v_names ->> (v_settlement ->> 'from')) IS NULL
       OR (v_names ->> (v_settlement ->> 'to')) IS NULL THEN
      RAISE EXCEPTION 'UNKNOWN_MEMBER: a settlement names somebody who is not in the people list'
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    v_from := (v_names ->> (v_settlement ->> 'from'))::uuid;
    v_to   := (v_names ->> (v_settlement ->> 'to'))::uuid;

    v_mutation := (v_settlement ->> 'clientMutationId')::uuid;
    -- Same idempotency rule as the expenses: a replayed import must not pay
    -- somebody twice.
    CONTINUE WHEN v_mutation IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.settlements s WHERE s.client_mutation_id = v_mutation
    );

    -- The file's word on the row, before anybody's consent is considered. A
    -- status the ledger has no name for is refused rather than cast blind.
    v_file_status := lower(COALESCE(v_settlement ->> 'status', 'confirmed'));
    IF v_file_status NOT IN ('confirmed', 'auto_confirmed', 'initiated', 'disputed', 'cancelled') THEN
      RAISE EXCEPTION 'INVALID_STATUS: a settlement cannot be imported as "%"', v_file_status
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT gm.profile_id IS NOT NULL INTO v_from_real
      FROM public.group_members gm WHERE gm.id = v_from;
    SELECT gm.profile_id IS NOT NULL INTO v_to_real
      FROM public.group_members gm WHERE gm.id = v_to;

    IF v_file_status IN ('confirmed', 'auto_confirmed') THEN
      -- Settled, says the file. It stays settled only if the person doing the
      -- import can vouch for the receipt: they are the payee, or the payee is
      -- a ghost and the payer is nobody else on Waves. Otherwise the member it
      -- names gets to confirm it, the way they would any settle-up (ADR-007).
      IF v_to = v_author OR (NOT v_to_real AND (v_from = v_author OR NOT v_from_real)) THEN
        v_status := 'confirmed';
      ELSE
        v_status := 'initiated';
      END IF;
    ELSE
      v_status := v_file_status::"SettlementStatus";
    END IF;

    -- A confirmed row keeps the file's date. A pending one is dated now, so the
    -- auto-confirm window starts when the people on Waves can first see it —
    -- not years ago in the file.
    v_at := CASE
      WHEN v_status = 'initiated' THEN now()
      ELSE COALESCE((v_settlement ->> 'at')::timestamptz, now())
    END;

    INSERT INTO public.settlements
      (group_id, from_member_id, to_member_id, currency, amount, method, status, note,
       initiated_at, confirmed_at, client_mutation_id)
    VALUES (
      p_group_id,
      v_from,
      v_to,
      upper(COALESCE(v_settlement ->> 'currency', 'INR'))::char(3),
      (v_settlement ->> 'amount')::bigint,
      COALESCE(v_settlement ->> 'method', 'other')::"SettlementMethod",
      v_status,
      v_settlement ->> 'note',
      v_at,
      CASE WHEN v_status = 'confirmed' THEN v_at END,
      v_mutation
    );

    IF v_status = 'initiated' THEN
      v_pending := v_pending + 1;
    END IF;
    v_settled := v_settled + 1;
  END LOOP;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (
    p_group_id, v_author, 'imported', 'group', p_group_id,
    jsonb_build_object(
      'expenses', v_created, 'ghosts', v_ghosts, 'settlements', v_settled,
      'settlementsPending', v_pending, 'from', p_origin
    )
  );

  RETURN jsonb_build_object(
    'groupId', p_group_id,
    'expenses', v_created,
    'ghosts', v_ghosts,
    'settlements', v_settled,
    'settlementsPending', v_pending,
    'members', v_names
  );
END
$$;


--
-- Name: waves_import_splitwise(uuid, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_import_splitwise(p_group_id uuid, p_people jsonb, p_expenses jsonb) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT public.waves_import_ledger(p_group_id, p_people, p_expenses, '[]'::jsonb, 'splitwise');
$$;


--
-- Name: waves_is_expense_party(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_is_expense_party(p_expense_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.expenses e
    JOIN public.expense_versions v ON v.id = e.current_version_id
    LEFT JOIN public.expense_payers ep ON ep.expense_version_id = v.id
    JOIN public.group_members gm
      ON gm.id = ep.member_id OR gm.id = v.author_member_id
    WHERE e.id = p_expense_id
      AND gm.profile_id = public.waves_current_profile_id()
      AND gm.left_at IS NULL
  )
$$;


--
-- Name: waves_is_settlement_party(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_is_settlement_party(p_settlement_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.settlements s
    JOIN public.group_members gm
      ON gm.id IN (s.from_member_id, s.to_member_id)
    WHERE s.id = p_settlement_id
      AND gm.profile_id = public.waves_current_profile_id()
      AND gm.left_at IS NULL
  )
$$;


--
-- Name: waves_item_claims(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_item_claims(p_receipt_id uuid) RETURNS TABLE(item_index integer, member_id uuid, revision integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT c.item_index, c.member_id, c.revision
  FROM public.receipt_item_claims c
  WHERE c.receipt_id = p_receipt_id AND c.released_at IS NULL
  ORDER BY c.item_index, c.member_id;
$$;


--
-- Name: waves_list_devices(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_list_devices() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'deviceId', device_id,
        'label', label,
        'platform', platform,
        'appVersion', app_version,
        'createdAt', created_at,
        'lastSeenAt', last_seen_at,
        'revokedAt', revoked_at
      )
      ORDER BY last_seen_at DESC
    ),
    '[]'::jsonb
  )
  FROM public.device_sessions
  WHERE profile_id = public.waves_current_profile_id()
    AND last_seen_at > now() - interval '90 days';
$$;


--
-- Name: waves_log_receipt_event(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_log_receipt_event(p_event_id uuid, p_group_id uuid, p_expense_id uuid, p_action text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_member   uuid;
BEGIN
  IF p_action NOT IN ('added', 'removed') THEN
    RAISE EXCEPTION 'INVALID_ACTION: added or removed' USING ERRCODE = 'check_violation';
  END IF;

  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL OR v_group_id <> p_group_id THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense in this group' USING ERRCODE = 'no_data_found';
  END IF;

  -- Membership is the authorisation: only a member of the group may write a line
  -- about it, and their identity is the session's, not a client argument.
  v_member := public.waves_my_member_id(p_group_id);
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: only a group member may log this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.expense_image_events
    (id, group_id, expense_id, actor_member_id, kind, action, visibility)
  VALUES
    (p_event_id, p_group_id, p_expense_id, v_member, 'receipt', p_action, 'group')
  ON CONFLICT (id) DO NOTHING;
END
$$;


--
-- Name: waves_log_voice_attempt(text, text, boolean, integer, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_log_voice_attempt(p_transcript text, p_locale text DEFAULT NULL::text, p_used_model boolean DEFAULT false, p_item_count integer DEFAULT 0, p_platform text DEFAULT NULL::text, p_app_version text DEFAULT NULL::text, p_client_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
  v_transcript text := left(trim(COALESCE(p_transcript, '')), 4000);
  v_id uuid;
BEGIN
  -- No session, or nothing to log: say nothing. This is a fire-and-forget
  -- reporter, so a null return is the quiet "not stored" the client expects.
  IF v_profile IS NULL OR length(v_transcript) = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.voice_attempts
    (profile_id, transcript, locale, used_model, item_count, platform, app_version, client_at)
  VALUES
    (v_profile, v_transcript, p_locale, COALESCE(p_used_model, false),
     GREATEST(COALESCE(p_item_count, 0), 0), p_platform, p_app_version, p_client_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_mark_notifications_read(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_mark_notifications_read(p_ids uuid[]) RETURNS integer
    LANGUAGE sql
    SET search_path TO 'public', 'pg_temp'
    AS $$
  -- SECURITY INVOKER on purpose: `notifications_update_own` is what decides
  -- whose inbox this is, and it is the same policy a direct PATCH would meet.
  WITH marked AS (
    UPDATE public.notifications
       SET read_at = now()
     WHERE id = ANY(p_ids) AND read_at IS NULL
    RETURNING 1
  )
  SELECT COUNT(*)::integer FROM marked;
$$;


--
-- Name: waves_member_group_id(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_member_group_id(p_member_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT group_id FROM public.group_members WHERE id = p_member_id
$$;


--
-- Name: waves_merge_ghosts(uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_merge_ghosts(p_member_ids uuid[], p_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile_id uuid := public.waves_current_profile_id();
  v_name       text := nullif(btrim(coalesce(p_name, '')), '');
  v_canonical  uuid;
  v_count      int;
  v_bad        int;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Serialise this owner's merges for the rest of the transaction, so the
  -- canonical lookup below and the write that follows it are atomic against a
  -- concurrent merge that shares a member. Released on commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('waves_merge_ghosts:' || v_profile_id::text)::bigint);

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'NAME_REQUIRED: the merged person needs a name'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Distinct, non-null members actually asked for.
  SELECT count(DISTINCT t.id) INTO v_count
    FROM unnest(p_member_ids) AS t(id)
   WHERE t.id IS NOT NULL;

  IF v_count < 2 THEN
    RAISE EXCEPTION 'TOO_FEW: pick at least two people to merge'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every id must be a ghost the caller shares a group with. Anything that is
  -- not — a real person, a member of a group the caller is not in, or an id that
  -- does not exist — makes the whole merge fail rather than merging a subset.
  SELECT count(*) INTO v_bad
    FROM unnest(p_member_ids) AS want(id)
   WHERE want.id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.group_members target
         JOIN public.group_members mine
           ON mine.group_id = target.group_id
          AND mine.profile_id = v_profile_id
          AND mine.left_at IS NULL
        WHERE target.id = want.id
          AND target.profile_id IS NULL
     );

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'NOT_MERGEABLE: every person must be a guest you share a group with'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The members explicitly picked this time.
  CREATE TEMP TABLE _sel ON COMMIT DROP AS
    SELECT DISTINCT m AS member_id
      FROM unnest(p_member_ids) AS m
     WHERE m IS NOT NULL;

  -- Any existing merge groups that overlap the selection: reusing the lowest of
  -- their person_ids (uuid has no min() aggregate, so order and take one) keeps a
  -- repeated merge stable rather than churning. No overlap leaves it NULL.
  SELECT gm.person_id INTO v_canonical
    FROM public.ghost_merges gm
   WHERE gm.owner = v_profile_id
     AND gm.member_id IN (SELECT member_id FROM _sel)
   ORDER BY gm.person_id
   LIMIT 1;

  -- No overlap with a prior merge: this is a brand-new person.
  IF v_canonical IS NULL THEN
    v_canonical := gen_random_uuid();
  END IF;

  -- The full union: the picked members plus every member already sharing a
  -- person_id with any of them, so a transitive merge folds into one identity.
  INSERT INTO public.ghost_merges (owner, member_id, person_id, display_name)
  SELECT v_profile_id, u.member_id, v_canonical, v_name
    FROM (
      SELECT member_id FROM _sel
      UNION
      SELECT gm.member_id
        FROM public.ghost_merges gm
       WHERE gm.owner = v_profile_id
         AND gm.person_id IN (
           SELECT gm2.person_id
             FROM public.ghost_merges gm2
            WHERE gm2.owner = v_profile_id
              AND gm2.member_id IN (SELECT member_id FROM _sel)
         )
    ) AS u(member_id)
  ON CONFLICT (owner, member_id)
  DO UPDATE SET person_id    = EXCLUDED.person_id,
                display_name = EXCLUDED.display_name
  -- Keep created_at, and only write (firing the sync trigger) on a real change,
  -- so an identical re-merge stamps no new updated_seq.
  WHERE ghost_merges.person_id   IS DISTINCT FROM EXCLUDED.person_id
     OR ghost_merges.display_name IS DISTINCT FROM EXCLUDED.display_name;

  RETURN v_canonical;
END
$$;


--
-- Name: waves_my_campaign(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_my_campaign() RETURNS TABLE(id uuid, title text, body text, cta_label text, promo_code text, ends_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT c.id, c.title, c.body, c.cta_label, c.promo_code, c.ends_at
    FROM public.campaigns c
    JOIN public.profiles p ON p.id = public.waves_current_profile_id()
   WHERE now() BETWEEN c.starts_at AND c.ends_at
     AND (c.audience_countries IS NULL OR p.country_code = ANY (c.audience_countries))
     AND public.waves_campaign_cohort(c.id, p.id) = 'targeted'
     AND NOT EXISTS (
       SELECT 1 FROM public.campaign_impressions i
        WHERE i.campaign_id = c.id AND i.profile_id = p.id
     )
   ORDER BY c.starts_at DESC
   LIMIT 1;
$$;


--
-- Name: waves_my_erasure_preview(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_my_erasure_preview() RETURNS TABLE(groups_count bigint, expenses_authored bigint, settlements_involved bigint, outstanding_currencies text[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH me AS (
    SELECT id FROM public.group_members
     WHERE profile_id = public.waves_current_profile_id()
  )
  SELECT
    (SELECT count(*) FROM me),
    (SELECT count(*) FROM public.expenses e
      WHERE e.created_by IN (SELECT id FROM me) AND e.deleted_at IS NULL),
    (SELECT count(*) FROM public.settlements s
      WHERE s.from_member_id IN (SELECT id FROM me)
         OR s.to_member_id IN (SELECT id FROM me)),
    COALESCE(
      (SELECT array_agg(DISTINCT b.currency::text)
         FROM public.group_balances b
        WHERE b.member_id IN (SELECT id FROM me) AND b.balance <> 0),
      ARRAY[]::text[]
    );
$$;


--
-- Name: waves_my_member_claims(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_my_member_claims() RETURNS TABLE(id uuid, group_id uuid, group_name text, ghost_name text, status text, created_at timestamp with time zone, decided_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT c.id, c.group_id, g.name, m.ghost_name, c.status, c.created_at, c.decided_at
    FROM public.member_claims c
    JOIN public.groups g        ON g.id = c.group_id
    JOIN public.group_members m ON m.id = c.member_id
   WHERE c.requester_id = public.waves_current_profile_id()
   ORDER BY c.created_at DESC;
$$;


--
-- Name: waves_my_member_id(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_my_member_id(p_group_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT gm.id
  FROM public.group_members gm
  WHERE gm.group_id = p_group_id
    AND gm.profile_id = public.waves_current_profile_id()
    AND gm.left_at IS NULL
  LIMIT 1
$$;


--
-- Name: waves_my_member_id_for(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_my_member_id_for(p_group_id uuid, p_profile_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT id FROM public.group_members
   WHERE group_id = p_group_id AND profile_id = p_profile_id AND left_at IS NULL
   LIMIT 1;
$$;


--
-- Name: waves_my_plan(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_my_plan(p_profile_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := COALESCE(p_profile_id, public.waves_current_profile_id());
  v_row     record;
BEGIN
  IF v_profile IS NULL THEN
    RETURN jsonb_build_object('tier', 'free', 'until', NULL, 'source', 'free', 'scanLimit', 20);
  END IF;

  SELECT period, current_period_end INTO v_row
  FROM public.subscriptions
  WHERE profile_id = v_profile
    AND tier = 'plus'
    -- 'grace' is still paid: the store is retrying a card, and taking the
    -- features away mid-retry punishes somebody whose bank was slow.
    AND status IN ('active', 'grace')
    AND (current_period_end IS NULL OR current_period_end > now())
  -- A lifetime purchase outranks a subscription that expires; otherwise the
  -- one that lasts longest wins. Somebody who bought both should get both.
  ORDER BY (current_period_end IS NULL) DESC, current_period_end DESC NULLS FIRST
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('tier', 'free', 'until', NULL, 'source', 'free', 'scanLimit', 20);
  END IF;

  RETURN jsonb_build_object(
    'tier', 'plus',
    'until', v_row.current_period_end,
    'source', CASE WHEN v_row.period = 'lifetime' THEN 'lifetime' ELSE 'subscription' END,
    'scanLimit', 300
  );
END
$$;


--
-- Name: waves_my_storage_usage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_my_storage_usage() RETURNS TABLE(used_bytes bigint, cap_bytes bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
BEGIN
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT COALESCE(SUM(bytes), 0)::bigint,
           public.waves_free_storage_cap()
      FROM public.storage_objects
     WHERE owner_profile_id = v_profile
       AND counted;
END
$$;


--
-- Name: waves_my_voice_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_my_voice_access() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
  v_period  text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_paid    boolean;
  v_free    integer;
  v_used    integer;
BEGIN
  IF v_profile IS NULL THEN
    RETURN jsonb_build_object(
      'paid', false, 'freeSeconds', 0, 'usedSeconds', 0,
      'remainingSeconds', 0, 'period', v_period);
  END IF;

  v_paid := public.waves_profile_is_paid(v_profile);
  v_free := public.waves_voice_stt_free_seconds();
  SELECT seconds INTO v_used
    FROM public.voice_stt_usage
   WHERE profile_id = v_profile AND period = v_period;
  v_used := COALESCE(v_used, 0);

  RETURN jsonb_build_object(
    'paid', v_paid,
    'freeSeconds', v_free,
    'usedSeconds', v_used,
    'remainingSeconds', CASE WHEN v_paid THEN NULL ELSE GREATEST(0, v_free - v_used) END,
    'period', v_period
  );
END;
$$;


--
-- Name: waves_new_group_join_token(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_new_group_join_token(p_group_id uuid, p_revoke_existing boolean) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_old   text;
  v_token text;
BEGIN
  SELECT join_token INTO v_old FROM public.groups WHERE id = p_group_id;

  IF p_revoke_existing AND v_old IS NOT NULL THEN
    UPDATE public.invites
       SET revoked_at = now()
     WHERE group_id = p_group_id
       AND token_hash = encode(extensions.digest(v_old, 'sha256'), 'hex')
       AND revoked_at IS NULL;
  END IF;

  -- 256 bits from two UUIDs (no pgcrypto needed for the token itself), hex, so
  -- it is URL-safe and needs no encoding in the link.
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  INSERT INTO public.invites (group_id, token_hash, created_by, expires_at, max_uses)
  VALUES (
    p_group_id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    public.waves_current_profile_id(),
    now() + interval '100 years',
    1000000
  );

  UPDATE public.groups SET join_token = v_token WHERE id = p_group_id;
  RETURN v_token;
END
$$;


--
-- Name: waves_next_capture_seq(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_next_capture_seq(p_owner uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.profiles
     SET captures_seq = captures_seq + 1
   WHERE id = p_owner
   RETURNING captures_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;


--
-- Name: waves_next_category_tag_seq(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_next_category_tag_seq(p_owner uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.profiles
     SET category_tags_seq = category_tags_seq + 1
   WHERE id = p_owner
   RETURNING category_tags_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;


--
-- Name: waves_next_ghost_merge_seq(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_next_ghost_merge_seq(p_owner uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.profiles
     SET ghost_merges_seq = ghost_merges_seq + 1
   WHERE id = p_owner
   RETURNING ghost_merges_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;


--
-- Name: waves_next_group_seq(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_next_group_seq(p_group_id uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.groups
     SET updated_seq = updated_seq + 1
   WHERE id = p_group_id
  RETURNING updated_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;


--
-- Name: waves_next_personal_seq(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_next_personal_seq(p_owner uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE public.profiles
     SET personal_seq = personal_seq + 1
   WHERE id = p_owner
   RETURNING personal_seq INTO v_seq;
  RETURN COALESCE(v_seq, 0);
END
$$;


--
-- Name: waves_notify(uuid, uuid, text, text, text, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_notify(p_profile_id uuid, p_group_id uuid, p_kind text, p_title text, p_body text, p_deep_link text, p_payload jsonb, p_dedupe_key text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id uuid;
BEGIN
  -- A ghost member has no profile to notify. Silently skipping is right: they
  -- are a placeholder for somebody who has not joined yet.
  IF p_profile_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notifications
    (profile_id, group_id, kind, title, body, deep_link, payload, channels, dedupe_key)
  VALUES
    (p_profile_id, p_group_id, p_kind, p_title, p_body, p_deep_link,
     COALESCE(p_payload, '{}'::jsonb), ARRAY['in_app']::text[], p_dedupe_key)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_notify_fanout_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_notify_fanout_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_key text;
BEGIN
  -- Never let a delivery hiccup roll back the write that created the
  -- notification — an expense, a settlement, a group-add. Whatever goes
  -- wrong here (no Vault secret yet, `pg_net` unavailable, anything else)
  -- is swallowed; the row stays in `notifications` and the cron still
  -- reaches it within five minutes regardless of what this trigger did.
  BEGIN
    SELECT decrypted_secret INTO v_key
      FROM vault.decrypted_secrets WHERE name = 'service_role_key';

    IF v_key IS NOT NULL THEN
      PERFORM net.http_post(
        url     := 'https://xvjzbpgcmotoahtqcxve.supabase.co/functions/v1/notify-fanout',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_key,
          'Content-Type',  'application/json'
        ),
        body    := '{}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NULL; -- ignored on an AFTER trigger
END
$$;


--
-- Name: waves_nudge_rate_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_nudge_rate_limit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.last_nudged_at IS NOT NULL
     AND OLD.last_nudged_at IS NOT NULL
     AND NEW.last_nudged_at <> OLD.last_nudged_at
     AND NEW.last_nudged_at < OLD.last_nudged_at + interval '1 day' THEN
    RAISE EXCEPTION 'NUDGE_RATE_LIMIT: only one nudge per pair per day'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: waves_nudge_to_settle(uuid, uuid, character); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_nudge_to_settle(p_group_id uuid, p_to_member_id uuid, p_currency character) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_me            uuid;   -- my member in this group: the one who is owed
  v_my_name       text;
  v_their_profile uuid;
  v_group_name    text;
  v_amount        bigint;
  v_notification  uuid;
BEGIN
  -- The caller must be a present member of the group. Anyone else has no
  -- business reading who owes whom in it, let alone tapping them on the
  -- shoulder about it.
  SELECT gm.id, COALESCE(p.display_name, 'Someone')
    INTO v_me, v_my_name
    FROM public.group_members gm
    JOIN public.profiles p ON p.id = gm.profile_id
   WHERE gm.group_id = p_group_id
     AND gm.profile_id = public.waves_current_profile_id()
     AND gm.left_at IS NULL;

  IF v_me IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_to_member_id = v_me THEN
    RAISE EXCEPTION 'CANNOT_NUDGE_SELF: that is you'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The person being nudged must be a present member with an account. A ghost
  -- has no inbox for it to land in — they are invited, not reminded (A25).
  SELECT gm.profile_id, g.name
    INTO v_their_profile, v_group_name
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id
   WHERE gm.id = p_to_member_id
     AND gm.group_id = p_group_id
     AND gm.left_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: they are not in that group'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_their_profile IS NULL THEN
    RAISE EXCEPTION 'GHOST_NO_INBOX: they have not joined yet — invite them instead'
      USING ERRCODE = 'check_violation';
  END IF;

  -- What they owe me in this currency, netting the two orientations the pair
  -- may be stored in (pairwise_balances holds each pair once, as `from` owing
  -- `to`). A nudge over a debt that is not there is the one thing that would
  -- make the reminder a lie, so a non-positive figure is refused rather than
  -- sent. Currency is explicit: two people can owe each other in two
  -- currencies at once, and there is no honest single number across them
  -- (ADR-003).
  SELECT COALESCE(
           (SELECT amount FROM public.pairwise_balances
             WHERE group_id = p_group_id AND from_member_id = p_to_member_id
               AND to_member_id = v_me AND currency = p_currency), 0)
       - COALESCE(
           (SELECT amount FROM public.pairwise_balances
             WHERE group_id = p_group_id AND from_member_id = v_me
               AND to_member_id = p_to_member_id AND currency = p_currency), 0)
    INTO v_amount;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'NOTHING_OWED: they do not owe you in %', p_currency
      USING ERRCODE = 'check_violation';
  END IF;

  -- Record the nudge. The unique index on (group, from, to) makes this an
  -- upsert; the BEFORE UPDATE trigger refuses a second touch inside a day with
  -- NUDGE_RATE_LIMIT. The INSERT path — the pair's first ever nudge — is not
  -- rate-limited, which is right: there is nothing for it to be too soon after.
  INSERT INTO public.reminders (group_id, from_member_id, to_member_id, last_nudged_at)
  VALUES (p_group_id, v_me, p_to_member_id, now())
  ON CONFLICT (group_id, from_member_id, to_member_id)
  DO UPDATE SET last_nudged_at = now();

  -- Land it in their inbox. The English title/body are the fallback a client
  -- shows only for a kind it does not know; every current build renders the
  -- real sentence from `kind` + `payload` in the reader's own language, so the
  -- `counterparty`/`amount`/`currency`/`group` facts are what actually matter.
  -- The dedupe key is per pair per day — a belt to the rate limit's braces, so
  -- even a retried call is a no-op rather than a second buzz.
  v_notification := public.waves_notify(
    v_their_profile,
    p_group_id,
    'nudge',
    'A gentle nudge from ' || v_my_name,
    'You have a pending balance in ' || v_group_name,
    'waves://group/' || p_group_id::text,
    jsonb_build_object(
      'counterparty', v_my_name,
      'amount',       v_amount::text,
      'currency',     p_currency,
      'group',        v_group_name
    ),
    'nudge:' || p_group_id::text || ':' || v_me::text || ':' || p_to_member_id::text
      || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
  );

  RETURN v_notification;
END
$$;


--
-- Name: waves_open_receipts(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_open_receipts(p_group_id uuid) RETURNS TABLE(id uuid, created_at timestamp with time zone, parsed jsonb, claimed integer, items integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    r.id,
    r.created_at,
    r.parsed,
    (
      SELECT count(DISTINCT c.item_index)::int
      FROM public.receipt_item_claims c
      WHERE c.receipt_id = r.id AND c.released_at IS NULL
    ),
    COALESCE(jsonb_array_length(r.parsed -> 'items'), 0)
  FROM public.receipts r
  WHERE r.group_id = p_group_id
    AND r.parse_status IN ('parsed', 'needs_review')
    AND r.parsed IS NOT NULL
    -- Once a version points at the receipt the bill has been split and the
    -- screen is history, not work in progress.
    AND NOT EXISTS (
      SELECT 1 FROM public.expense_versions v WHERE v.receipt_id = r.id
    )
  ORDER BY r.created_at DESC;
$$;


--
-- Name: waves_people_i_owe(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_people_i_owe() RETURNS TABLE(person_key text, profile_id uuid, member_id uuid, display_name text, avatar_url text, is_ghost boolean, currency character, net bigint, group_count integer, only_group_id uuid, last_activity_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH me AS (
    SELECT gm.id AS member_id, gm.group_id
      FROM public.group_members gm
     WHERE gm.profile_id = public.waves_current_profile_id()
       AND gm.left_at IS NULL
  ),
  edges AS (
    SELECT pb.group_id, pb.to_member_id AS other_member_id, pb.currency, -pb.amount AS net
      FROM public.pairwise_balances pb
      JOIN me ON me.group_id = pb.group_id AND me.member_id = pb.from_member_id
    UNION ALL
    SELECT pb.group_id, pb.from_member_id, pb.currency, pb.amount
      FROM public.pairwise_balances pb
      JOIN me ON me.group_id = pb.group_id AND me.member_id = pb.to_member_id
  ),
  -- The newest activity per member, from every place a member leaves a
  -- timestamp: expense versions they paid or shared, and settlements either way.
  member_activity AS (
    SELECT a.member_id, max(a.ts) AS last_activity_at
      FROM (
        SELECT epy.member_id, ev.created_at AS ts
          FROM public.expense_payers epy
          JOIN public.expense_versions ev ON ev.id = epy.expense_version_id
          JOIN public.expenses ex ON ex.id = ev.expense_id AND ex.deleted_at IS NULL
        UNION ALL
        SELECT esh.member_id, ev.created_at
          FROM public.expense_shares esh
          JOIN public.expense_versions ev ON ev.id = esh.expense_version_id
          JOIN public.expenses ex ON ex.id = ev.expense_id AND ex.deleted_at IS NULL
        UNION ALL
        SELECT s.from_member_id, s.created_at FROM public.settlements s
        UNION ALL
        SELECT s.to_member_id, s.created_at FROM public.settlements s
      ) a(member_id, ts)
      GROUP BY a.member_id
  ),
  named AS (
    SELECT
      e.group_id,
      e.currency,
      e.net,
      gm.id            AS member_id,
      gm.profile_id,
      -- A profile id is proof of one human; a ghost merge is the caller's own
      -- proof; failing both, a ghost stays keyed to its own group.
      COALESCE(gm.profile_id::text, mrg.person_id::text, gm.id::text) AS person_key,
      COALESCE(p.display_name, mrg.display_name, gm.ghost_name, 'Someone') AS display_name,
      COALESCE(p.avatar_url, public.waves_gravatar_url(gm.invite_email)) AS avatar_url,
      gm.profile_id IS NULL AS is_ghost,
      ma.last_activity_at
    FROM edges e
    JOIN public.group_members gm ON gm.id = e.other_member_id
    LEFT JOIN public.profiles p ON p.id = gm.profile_id
    LEFT JOIN member_activity ma ON ma.member_id = gm.id
    LEFT JOIN public.ghost_merges mrg
      ON mrg.member_id = gm.id
     AND mrg.owner = public.waves_current_profile_id()
  )
  SELECT
    n.person_key,
    max(n.profile_id::text)::uuid                       AS profile_id,
    max(n.member_id::text)::uuid                        AS member_id,
    max(n.display_name)                                 AS display_name,
    max(n.avatar_url)                                   AS avatar_url,
    bool_and(n.is_ghost)                                AS is_ghost,
    n.currency,
    sum(n.net)::bigint                                  AS net,
    count(DISTINCT n.group_id)::int                     AS group_count,
    CASE WHEN count(DISTINCT n.group_id) = 1
         THEN max(n.group_id::text)::uuid END           AS only_group_id,
    max(n.last_activity_at)                             AS last_activity_at
  FROM named n
  GROUP BY n.person_key, n.currency
  HAVING sum(n.net) <> 0
  ORDER BY abs(sum(n.net)) DESC, max(n.display_name);
$$;


--
-- Name: waves_person_group_balances(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_person_group_balances(p_person_key text) RETURNS TABLE(group_id uuid, group_name text, cover_emoji text, currency character, net bigint, is_ghost boolean, display_name text)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH me AS (
    SELECT gm.id AS member_id, gm.group_id
      FROM public.group_members gm
     WHERE gm.profile_id = public.waves_current_profile_id()
       AND gm.left_at IS NULL
  ),
  edges AS (
    SELECT pb.group_id, pb.to_member_id AS other_member_id, pb.currency, -pb.amount AS net
      FROM public.pairwise_balances pb
      JOIN me ON me.group_id = pb.group_id AND me.member_id = pb.from_member_id
    UNION ALL
    SELECT pb.group_id, pb.from_member_id, pb.currency, pb.amount
      FROM public.pairwise_balances pb
      JOIN me ON me.group_id = pb.group_id AND me.member_id = pb.to_member_id
  ),
  named AS (
    SELECT
      e.group_id,
      e.currency,
      e.net,
      -- The same key the list rolls people up under: a profile id is proof of
      -- one human; a ghost merge is the caller's own proof; failing both, a
      -- ghost stays keyed to its own group membership.
      COALESCE(gm.profile_id::text, mrg.person_id::text, gm.id::text) AS person_key,
      COALESCE(p.display_name, mrg.display_name, gm.ghost_name, 'Someone') AS display_name,
      gm.profile_id IS NULL AS is_ghost
    FROM edges e
    JOIN public.group_members gm ON gm.id = e.other_member_id
    LEFT JOIN public.profiles p ON p.id = gm.profile_id
    LEFT JOIN public.ghost_merges mrg
      ON mrg.member_id = gm.id
     AND mrg.owner = public.waves_current_profile_id()
  )
  SELECT
    n.group_id,
    g.name         AS group_name,
    g.cover_emoji,
    n.currency,
    sum(n.net)::bigint    AS net,
    bool_and(n.is_ghost)  AS is_ghost,
    max(n.display_name)   AS display_name
  FROM named n
  JOIN public.groups g ON g.id = n.group_id
  WHERE n.person_key = p_person_key
  GROUP BY n.group_id, g.name, g.cover_emoji, n.currency
  HAVING sum(n.net) <> 0
  ORDER BY g.name, n.currency;
$$;


--
-- Name: waves_profile_is_paid(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_profile_is_paid(p_profile uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.subscriptions s
     WHERE s.profile_id = p_profile
       AND s.status = 'active'
       AND (s.current_period_end IS NULL OR s.current_period_end > now())
  );
$$;


--
-- Name: waves_profiles_share_group(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_profiles_share_group(p_a uuid, p_b uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p_a = p_b OR EXISTS (
    SELECT 1
      FROM public.group_members ma
      JOIN public.group_members mb ON mb.group_id = ma.group_id
     WHERE ma.profile_id = p_a AND ma.left_at IS NULL
       AND mb.profile_id = p_b AND mb.left_at IS NULL
  );
$$;


--
-- Name: waves_publish_receipt_items(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_publish_receipt_items(p_receipt_id uuid, p_items jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.receipts WHERE id = p_receipt_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such receipt' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'INVALID_ITEMS: a bill needs lines' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM public.receipt_item_claims WHERE receipt_id = p_receipt_id) THEN
    RAISE EXCEPTION 'ALREADY_CLAIMING: somebody has started claiming these lines'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.receipts
     SET parsed = jsonb_set(COALESCE(parsed, '{}'::jsonb), '{items}', p_items, true),
         updated_at = now()
   WHERE id = p_receipt_id;
END
$$;


--
-- Name: waves_rate_limit(text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_rate_limit(p_subject text, p_bucket text, p_limit integer, p_window_seconds integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_window       integer;
  v_limit        integer;
  v_start        timestamptz;
  v_hits         integer;
  v_allowed      boolean;
  v_master       boolean;
  v_rule_enabled boolean;
  v_rule_calls   integer;
  v_rule_window  integer;
BEGIN
  IF p_subject IS NULL OR p_subject = '' OR p_bucket IS NULL OR p_bucket = '' THEN
    RAISE EXCEPTION 'waves_rate_limit needs a subject and a bucket';
  END IF;

  -- Master off, or this bucket switched off: let it straight through. Nothing is
  -- counted, so turning the limit back on starts from a clean window rather than
  -- from whatever piled up while it was off.
  SELECT enabled INTO v_master FROM public.rate_limit_settings WHERE id = true;
  IF v_master IS NOT NULL AND NOT v_master THEN
    RETURN jsonb_build_object(
      'allowed', true, 'hits', 0, 'limit', 0,
      'remaining', 2147483647, 'retryAfter', 0, 'resetAt', clock_timestamp()
    );
  END IF;

  -- The code default is the fallback; a row for this bucket overrides it.
  v_window := GREATEST(COALESCE(p_window_seconds, 60), 1);
  v_limit  := GREATEST(COALESCE(p_limit, 0), 0);

  SELECT enabled, max_calls, window_seconds
    INTO v_rule_enabled, v_rule_calls, v_rule_window
    FROM public.rate_limit_rules
   WHERE bucket = p_bucket;

  IF FOUND THEN
    IF NOT v_rule_enabled THEN
      RETURN jsonb_build_object(
        'allowed', true, 'hits', 0, 'limit', 0,
        'remaining', 2147483647, 'retryAfter', 0, 'resetAt', clock_timestamp()
      );
    END IF;
    v_limit  := GREATEST(v_rule_calls, 0);
    v_window := GREATEST(v_rule_window, 1);
  END IF;

  -- Floor the clock to the window. Every caller in the same window agrees on
  -- the same `window_start` without anybody having to store when it opened.
  v_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / v_window) * v_window
  );

  INSERT INTO public.rate_limit_hits AS existing (subject, bucket, window_start, hits)
  VALUES (p_subject, p_bucket, v_start, 1)
  ON CONFLICT (subject, bucket, window_start)
    DO UPDATE SET hits = existing.hits + 1
  RETURNING existing.hits INTO v_hits;

  v_allowed := v_hits <= v_limit;

  RETURN jsonb_build_object(
    'allowed',   v_allowed,
    'hits',      v_hits,
    'limit',     v_limit,
    'remaining', GREATEST(v_limit - v_hits, 0),
    'retryAfter', CASE
                    WHEN v_allowed THEN 0
                    ELSE GREATEST(
                      ceil(extract(epoch FROM (v_start + make_interval(secs => v_window))
                                              - clock_timestamp()))::integer,
                      1
                    )
                  END,
    'resetAt',   v_start + make_interval(secs => v_window)
  );
END
$$;


--
-- Name: waves_receipt_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_receipt_cap() RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT COALESCE((SELECT value FROM public.app_config WHERE key = 'receipt_cap_per_group'), 3);
$$;


--
-- Name: waves_receipt_scan_quota(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_receipt_scan_quota() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT jsonb_build_object(
    'used', public.waves_scans_used_this_month(),
    'limit', (public.waves_my_plan() ->> 'scanLimit')::int,
    'remaining', greatest(
      0,
      (public.waves_my_plan() ->> 'scanLimit')::int - public.waves_scans_used_this_month()
    ),
    'tier', public.waves_my_plan() ->> 'tier'
  );
$$;


--
-- Name: waves_record_email_event(text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_record_email_event(p_resend_email_id text, p_event text, p_address text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_sent        record;
  v_address     text := lower(trim(COALESCE(p_address, '')));
  v_bounce_type text := p_payload #>> '{data,bounce,type}';
  v_suppressed  boolean := FALSE;
BEGIN
  IF p_event IS NULL OR p_event = '' THEN
    RAISE EXCEPTION 'waves_record_email_event needs an event';
  END IF;

  SELECT e.notification_id, e.profile_id, e.template
    INTO v_sent
  FROM public.email_events e
  WHERE e.resend_email_id = p_resend_email_id
    AND e.event = 'sent'
  ORDER BY e.created_at
  LIMIT 1;

  IF v_sent.profile_id IS NOT NULL THEN
    INSERT INTO public.email_events
      (notification_id, profile_id, resend_email_id, template, event, payload)
    VALUES
      (v_sent.notification_id, v_sent.profile_id, p_resend_email_id,
       COALESCE(v_sent.template, 'unknown'), p_event, COALESCE(p_payload, '{}'::jsonb));

    -- The inbox row keeps up with what actually happened, so "we emailed you"
    -- in the UI is never a claim the evidence contradicts.
    IF p_event IN ('delivered', 'bounced', 'complained') AND v_sent.notification_id IS NOT NULL THEN
      UPDATE public.notifications
         SET email_status = p_event::public."DeliveryStatus"
       WHERE id = v_sent.notification_id;
    END IF;
  END IF;

  IF p_event = 'complained' THEN
    v_suppressed := public.waves_suppress_email(v_address, 'complained', COALESCE(p_payload, '{}'::jsonb));
  ELSIF p_event = 'bounced' AND COALESCE(v_bounce_type, '') <> 'Transient' THEN
    v_suppressed := public.waves_suppress_email(v_address, 'bounced', COALESCE(p_payload, '{}'::jsonb));
  END IF;

  RETURN jsonb_build_object(
    'matched', v_sent.profile_id IS NOT NULL,
    'suppressed', v_suppressed
  );
END
$$;


--
-- Name: waves_record_receipt(uuid, uuid, uuid, text, text, text, jsonb, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_record_receipt(p_group_id uuid, p_receipt_id uuid, p_profile_id uuid, p_source text, p_storage_path text, p_raw_text text, p_parsed jsonb, p_status text, p_input_tokens integer DEFAULT 0, p_output_tokens integer DEFAULT 0) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Serialize recording for this group, so the count below and the INSERT are
  -- atomic against a concurrent recorder for the same group (TOCTOU). Keyed on
  -- the group, released on commit/rollback. Same device as the ghost-merge
  -- serialization (20260816150000).
  PERFORM pg_advisory_xact_lock(hashtext('waves_record_receipt:' || p_group_id::text)::bigint);

  -- The group question first: a non-null id that already exists in a DIFFERENT
  -- group is neither a new receipt for this group nor a valid update of one, so
  -- it is refused before the cap is even consulted — an accurate error, and no
  -- report of this group's cap state for a receipt that was never in it.
  IF p_receipt_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.receipts
     WHERE id = p_receipt_id AND group_id <> p_group_id
  ) THEN
    RAISE EXCEPTION 'RECEIPT_GROUP_MISMATCH'
      USING ERRCODE = 'check_violation',
            HINT = 'That receipt belongs to a different group.';
  END IF;

  -- The ceiling, enforced at the one insert path. A paid group is exempt; an
  -- update of a receipt that already exists IN THIS GROUP is not a new receipt
  -- and is exempt.
  IF NOT public.waves_group_is_paid(p_group_id)
     AND (p_receipt_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM public.receipts
             WHERE id = p_receipt_id AND group_id = p_group_id
          ))
     AND (SELECT count(*) FROM public.receipts WHERE group_id = p_group_id)
         >= public.waves_receipt_cap()
  THEN
    RAISE EXCEPTION 'RECEIPT_CAP'
      USING ERRCODE = 'check_violation',
            HINT = 'This group has reached its receipt limit; upgrade or add storage to add more.';
  END IF;

  -- Insert, or update only when the conflicting row is already this group's. The
  -- cross-group case is already refused above; this WHERE is the backstop.
  INSERT INTO public.receipts
    (id, group_id, storage_path, source, raw_text, parse_status, parsed, created_by)
  VALUES
    (COALESCE(p_receipt_id, gen_random_uuid()), p_group_id, p_storage_path,
     p_source::"ReceiptSource", p_raw_text, p_status::"ParseStatus", p_parsed,
     public.waves_my_member_id_for(p_group_id, p_profile_id))
  ON CONFLICT (id) DO UPDATE
    SET parsed = excluded.parsed,
        parse_status = excluded.parse_status,
        raw_text = excluded.raw_text
    WHERE receipts.group_id = p_group_id
  RETURNING id INTO v_id;

  -- Backstop: no row means the id exists but in a different group (already caught
  -- above). Refuse rather than return NULL.
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'RECEIPT_GROUP_MISMATCH'
      USING ERRCODE = 'check_violation',
            HINT = 'That receipt belongs to a different group.';
  END IF;

  -- Metered because each scan has a real API cost to watch (ADR-011).
  INSERT INTO public.usage_events
    (profile_id, group_id, kind, input_tokens, output_tokens, metadata)
  VALUES (p_profile_id, p_group_id, 'receipt_scan', p_input_tokens, p_output_tokens,
          jsonb_build_object('receiptId', v_id, 'status', p_status));

  RETURN v_id;
END
$$;


--
-- Name: waves_record_settlement(uuid, uuid, uuid, bigint, text, character, text, jsonb, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_record_settlement(p_group_id uuid, p_from_member_id uuid, p_to_member_id uuid, p_amount bigint, p_method text, p_currency character DEFAULT NULL::bpchar, p_note text DEFAULT NULL::text, p_allocations jsonb DEFAULT '[]'::jsonb, p_client_mutation_id uuid DEFAULT NULL::uuid, p_rail text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_settlement_id uuid;
  v_currency      char(3);
  v_actor         uuid;
  v_allocation    jsonb;
  v_rail          text := COALESCE(NULLIF(btrim(p_rail), ''), p_method);
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in this group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Resolve the caller's own member id up front: it is both the authorization
  -- check below and the actor on the activity entry further down.
  v_actor := public.waves_my_member_id(p_group_id);
  IF v_actor IS NULL OR v_actor NOT IN (p_from_member_id, p_to_member_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: you can only record a settlement you are part of'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Both parties must be members of THIS group. The FKs only prove the ids are
  -- real `group_members` rows, not that they belong here — without this a member
  -- could name a party from another group, and auto-confirm would later write an
  -- offsetting balance against a member nobody in this group can see, erasing
  -- their own debt while the per-group sum still totals zero.
  IF NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.id = p_from_member_id AND gm.group_id = p_group_id
      )
     OR NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.id = p_to_member_id AND gm.group_id = p_group_id
      ) THEN
    RAISE EXCEPTION 'UNKNOWN_MEMBER: both parties must be members of this group'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: settle a positive amount' USING ERRCODE = 'check_violation';
  END IF;

  -- Replaying the same mutation must not create a second settlement (ADR-005).
  IF p_client_mutation_id IS NOT NULL THEN
    SELECT id INTO v_settlement_id
    FROM public.settlements WHERE client_mutation_id = p_client_mutation_id;
    IF v_settlement_id IS NOT NULL THEN
      RETURN v_settlement_id;
    END IF;
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  INSERT INTO public.settlements
    (group_id, from_member_id, to_member_id, currency, amount, method, rail, status, note,
     client_mutation_id)
  VALUES
    (p_group_id, p_from_member_id, p_to_member_id, upper(v_currency), p_amount,
     CASE WHEN p_method IN ('upi', 'cash', 'bank', 'other') THEN p_method ELSE 'other' END
       ::"SettlementMethod",
     v_rail, 'initiated', p_note, p_client_mutation_id)
  RETURNING id INTO v_settlement_id;

  FOR v_allocation IN SELECT * FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb))
  LOOP
    INSERT INTO public.settlement_allocations (settlement_id, expense_id, amount)
    VALUES (
      v_settlement_id,
      (v_allocation ->> 'expenseId')::uuid,
      (v_allocation ->> 'amount')::bigint
    )
    ON CONFLICT (settlement_id, expense_id)
    DO UPDATE SET amount = public.settlement_allocations.amount + EXCLUDED.amount;
  END LOOP;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (p_group_id, v_actor, 'settled', 'settlement', v_settlement_id,
          jsonb_build_object('amount', p_amount, 'currency', v_currency,
                             'method', p_method, 'rail', v_rail));

  RETURN v_settlement_id;
END
$$;


--
-- Name: waves_redeem_promo(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_redeem_promo(p_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
  v_code    public.promo_codes%ROWTYPE;
  v_sub     uuid;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;

  SELECT * INTO v_code
    FROM public.promo_codes
   WHERE code = upper(trim(COALESCE(p_code, '')))
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'UNKNOWN_CODE');
  END IF;

  IF v_code.expires_at IS NOT NULL AND v_code.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'EXPIRED');
  END IF;

  IF v_code.redeemed_count >= v_code.max_redemptions THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'EXHAUSTED');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.promo_redemptions
     WHERE code = v_code.code AND profile_id = v_profile
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_REDEEMED');
  END IF;

  v_sub := public.waves_grant_promo(
    v_profile,
    v_code.days,
    'promo:' || v_code.code || ':' || v_profile::text
  );

  IF v_sub IS NULL THEN
    -- The unique key rejected it, so this person already holds this grant.
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_REDEEMED');
  END IF;

  INSERT INTO public.promo_redemptions (code, profile_id, subscription_id)
  VALUES (v_code.code, v_profile, v_sub);

  UPDATE public.promo_codes
     SET redeemed_count = redeemed_count + 1
   WHERE code = v_code.code;

  RETURN jsonb_build_object(
    'ok', true,
    'tier', v_code.tier,
    'days', v_code.days,
    'until', (now() + make_interval(days => v_code.days))
  );
END
$$;


--
-- Name: waves_refresh_group_balances(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_refresh_group_balances(p_group_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM public.group_balances WHERE group_id = p_group_id;
  INSERT INTO public.group_balances (group_id, member_id, currency, balance, updated_at)
  SELECT p_group_id, t.member_id, t.currency, t.balance, now()
  FROM public.waves_group_balances_truth(p_group_id) t;

  DELETE FROM public.pairwise_balances WHERE group_id = p_group_id;
  INSERT INTO public.pairwise_balances
    (group_id, from_member_id, to_member_id, currency, amount, updated_at)
  SELECT p_group_id, t.from_member_id, t.to_member_id, t.currency, t.amount, now()
  FROM public.waves_group_pairwise_truth(p_group_id) t;
END
$$;


--
-- Name: waves_register_device(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_register_device(p_device_id text, p_label text DEFAULT 'This device'::text, p_platform text DEFAULT 'unknown'::text, p_app_version text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
  v_tier    text := public.waves_my_plan() ->> 'tier';
  v_limit   int;
  v_active  int;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN: only a signed-in account has devices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_device_id IS NULL OR length(trim(p_device_id)) = 0 THEN
    RAISE EXCEPTION 'BAD_DEVICE_ID: a device id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.device_sessions
    (profile_id, device_id, label, platform, app_version, last_seen_at, revoked_at)
  VALUES
    (v_profile, p_device_id, COALESCE(NULLIF(trim(p_label), ''), 'This device'),
     COALESCE(NULLIF(trim(p_platform), ''), 'unknown'), p_app_version, now(), NULL)
  ON CONFLICT (profile_id, device_id) DO UPDATE
    SET label        = EXCLUDED.label,
        platform     = EXCLUDED.platform,
        app_version  = EXCLUDED.app_version,
        last_seen_at = now(),
        revoked_at   = NULL;

  v_limit := public.waves_device_cap(v_profile, v_tier = 'plus');

  SELECT count(*) INTO v_active
  FROM public.device_sessions
  WHERE profile_id = v_profile
    AND revoked_at IS NULL
    AND last_seen_at > now() - interval '14 days';

  RETURN jsonb_build_object(
    'tier', v_tier,
    'limit', v_limit,
    'activeCount', v_active,
    'overLimit', v_active > v_limit
  );
END
$$;


--
-- Name: waves_remove_expense_attachment(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_remove_expense_attachment(p_attachment_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_expense_id uuid;
  v_group_id   uuid;
  v_visibility text;
BEGIN
  SELECT expense_id, group_id, visibility
    INTO v_expense_id, v_group_id, v_visibility
  FROM public.expense_attachments WHERE id = p_attachment_id;
  IF v_expense_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.waves_is_expense_party(v_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may remove this attachment'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_attachments
     SET deleted_at = now()
   WHERE id = p_attachment_id AND deleted_at IS NULL;

  IF FOUND THEN
    INSERT INTO public.expense_image_events
      (id, group_id, expense_id, actor_member_id, kind, action, visibility)
    VALUES
      (gen_random_uuid(), v_group_id, v_expense_id,
       public.waves_my_member_id(v_group_id), 'attachment', 'removed', v_visibility);
  END IF;
END
$$;


--
-- Name: waves_remove_plan_item(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_remove_plan_item(p_item_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.trip_plan_items WHERE id = p_item_id;
  IF v_group_id IS NULL THEN
    RETURN; -- Never existed. Removing nothing is not an error.
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Soft delete, and only when still live, so removing twice does not re-stamp.
  UPDATE public.trip_plan_items
     SET deleted_at = now()
   WHERE id = p_item_id AND deleted_at IS NULL;
END
$$;


--
-- Name: waves_remove_settlement_proof(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_remove_settlement_proof(p_proof_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_settlement_id uuid;
BEGIN
  SELECT settlement_id INTO v_settlement_id
  FROM public.settlement_proofs WHERE id = p_proof_id;
  IF v_settlement_id IS NULL THEN
    RETURN; -- Already gone.
  END IF;
  IF NOT public.waves_is_settlement_party(v_settlement_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may remove a proof'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.settlement_proofs
     SET deleted_at = now()
   WHERE id = p_proof_id AND deleted_at IS NULL;
END
$$;


--
-- Name: waves_remove_trip_photo(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_remove_trip_photo(p_photo_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.trip_photos WHERE id = p_photo_id;
  IF v_group_id IS NULL THEN
    RETURN; -- Never existed. Removing nothing is not an error.
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Only when still live, so removing twice does not re-stamp the tombstone.
  UPDATE public.trip_photos
     SET deleted_at = now()
   WHERE id = p_photo_id AND deleted_at IS NULL;
END
$$;


--
-- Name: waves_replace_expense_attachment_image(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_replace_expense_attachment_image(p_attachment_id uuid, p_new_path text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_expense_id uuid;
BEGIN
  IF coalesce(btrim(p_new_path), '') = '' THEN
    RAISE EXCEPTION 'INVALID_PATH: a replacement needs a stored image'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT expense_id INTO v_expense_id
  FROM public.expense_attachments
  WHERE id = p_attachment_id AND deleted_at IS NULL;
  IF v_expense_id IS NULL THEN
    RETURN;
  END IF;

  -- The new key MUST stay scoped to this expense, exactly like the attach RPC.
  IF p_new_path NOT LIKE v_expense_id::text || '/%' THEN
    RAISE EXCEPTION 'INVALID_PATH: the key must be scoped to its expense'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.waves_is_expense_party(v_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may adjust this image'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The replacement bytes must really exist: a committed object at the new key.
  -- Without this the row could be repointed at a never-uploaded path, and the
  -- markup would be cleared, leaving the attachment pointing at nothing.
  PERFORM public.waves_require_committed_object('expense-attachments', btrim(p_new_path));

  UPDATE public.expense_attachments
     SET storage_path = btrim(p_new_path),
         annotations  = NULL
   WHERE id = p_attachment_id AND deleted_at IS NULL;
END
$$;


--
-- Name: waves_request_member_claim(uuid, uuid, uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_request_member_claim(p_group_id uuid, p_member_id uuid, p_profile_id uuid, p_name text DEFAULT NULL::text, p_invite_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_member   public.group_members%ROWTYPE;
  v_group    text;
  v_id       uuid;
  v_admin    record;
  v_consumed boolean;
BEGIN
  SELECT * INTO v_member
    FROM public.group_members
   WHERE id = p_member_id AND group_id = p_group_id
   FOR UPDATE;

  IF NOT FOUND OR v_member.left_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NOT_CLAIMABLE');
  END IF;

  -- Already somebody's. The check is repeated at decision time as well: this
  -- one is for the sentence, that one is for the guarantee.
  IF v_member.profile_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_CLAIMED');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.group_members
     WHERE group_id = p_group_id AND profile_id = p_profile_id AND left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_A_MEMBER');
  END IF;

  -- The same person asking twice. Their existing request is the answer, and a
  -- second notification to every admin is not — and, since this migration, a
  -- second invite use is not either. Safe under the `FOR UPDATE` on the member
  -- above, which serialises requests for one place, so two concurrent asks
  -- cannot both slip past this into the consume below.
  SELECT id INTO v_id
    FROM public.member_claims
   WHERE member_id = p_member_id AND requester_id = p_profile_id AND status = 'pending';

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'claim_id', v_id, 'already_pending', true);
  END IF;

  -- Past every short-circuit: this is a brand-new claim, and only now is a use
  -- worth spending. The consume is atomic (a conditional UPDATE that re-checks
  -- revocation, expiry and the cap under the invite's row lock), so if the link
  -- has filled up — including a direct join or another new claim winning the
  -- last slot in a concurrent race — this claim is refused and no row is written.
  IF p_invite_id IS NOT NULL THEN
    SELECT public.waves_consume_invite(p_invite_id) INTO v_consumed;
    IF v_consumed IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'INVITE_INVALID');
    END IF;
  END IF;

  INSERT INTO public.member_claims (group_id, member_id, requester_id, requested_name)
  VALUES (p_group_id, p_member_id, p_profile_id, NULLIF(btrim(COALESCE(p_name, '')), ''))
  RETURNING id INTO v_id;

  SELECT name INTO v_group FROM public.groups WHERE id = p_group_id;

  -- Every admin, not just the creator. A group whose only admin has stopped
  -- opening the app is a group where nobody can ever join again.
  FOR v_admin IN
    SELECT profile_id FROM public.group_members
     WHERE group_id = p_group_id AND role = 'admin'
       AND profile_id IS NOT NULL AND left_at IS NULL
  LOOP
    PERFORM public.waves_notify(
      v_admin.profile_id,
      p_group_id,
      'ghost_claim_requested',
      'Someone wants to join ' || COALESCE(v_group, 'a group'),
      'They say they are ' || COALESCE(v_member.ghost_name, 'someone already listed'),
      '/group/' || p_group_id::text || '/members',
      jsonb_build_object(
        'claim_id', v_id,
        'member_id', p_member_id,
        'ghost_name', v_member.ghost_name,
        'requested_name', NULLIF(btrim(COALESCE(p_name, '')), '')
      ),
      'claim:' || v_id::text || ':' || v_admin.profile_id::text
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'claim_id', v_id, 'already_pending', false);
END
$$;


--
-- Name: waves_require_committed_object(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_require_committed_object(p_logical_bucket text, p_path text) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.storage_objects
     WHERE logical_bucket = p_logical_bucket
       AND path = p_path
       AND NOT pending
  ) THEN
    RAISE EXCEPTION 'OBJECT_NOT_COMMITTED: no uploaded image backs this path'
      USING ERRCODE = 'check_violation',
            HINT = 'Upload the image (put + commit) before recording its metadata.';
  END IF;
END
$$;


--
-- Name: waves_reset_group_join_token(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_reset_group_join_token(p_group_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'ADMIN_ONLY: only an admin can reset the join link'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN public.waves_new_group_join_token(p_group_id, true);
END
$$;


--
-- Name: waves_resolve_dispute(uuid, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_resolve_dispute(p_dispute_id uuid, p_accept boolean, p_note text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_expense_id  UUID;
  v_group_id    UUID;
  v_author      UUID;
  v_actor       UUID;
  v_disputer    UUID;
  v_disputer_pid UUID;
  v_description TEXT;
  v_group_name  TEXT;
BEGIN
  SELECT d.expense_id, d.member_id, e.group_id, v.author_member_id, v.description
    INTO v_expense_id, v_disputer, v_group_id, v_author, v_description
  FROM public.expense_disputes d
  JOIN public.expenses e ON e.id = d.expense_id
  LEFT JOIN public.expense_versions v ON v.id = e.current_version_id
  WHERE d.id = p_dispute_id AND d.status = 'open';

  IF v_expense_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no open dispute with that id' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.waves_my_member_id(v_group_id);

  -- The person who entered the expense, or an admin. Not the disputer: nobody
  -- gets to rule on their own complaint, in either direction.
  IF v_actor IS NULL
     OR v_actor = v_disputer
     OR (v_actor IS DISTINCT FROM v_author AND NOT public.is_group_admin(v_group_id))
  THEN
    RAISE EXCEPTION 'NOT_YOURS_TO_RESOLVE: only the person who added the expense, or an admin, can answer this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_disputes
     SET status = CASE WHEN p_accept THEN 'resolved' ELSE 'rejected' END,
         resolution_note = NULLIF(btrim(p_note), ''),
         resolved_by_member_id = v_actor,
         resolved_at = now(),
         updated_at = now()
   WHERE id = p_dispute_id;

  SELECT name INTO v_group_name FROM public.groups WHERE id = v_group_id;

  INSERT INTO public.activity_log
    (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES
    (v_group_id, v_actor,
     CASE WHEN p_accept THEN 'accepted_dispute' ELSE 'rejected_dispute' END,
     'expense', v_expense_id,
     jsonb_build_object('description', v_description, 'note', NULLIF(btrim(p_note), '')));

  SELECT profile_id INTO v_disputer_pid FROM public.group_members WHERE id = v_disputer;
  IF v_disputer_pid IS NOT NULL THEN
    PERFORM public.waves_notify(
      v_disputer_pid, v_group_id, 'expense_dispute_resolved',
      CASE WHEN p_accept THEN 'Your correction was accepted' ELSE 'Your correction was declined' END,
      COALESCE(v_description, 'An expense'),
      'waves://group/' || v_group_id::text || '/expense/' || v_expense_id::text,
      jsonb_build_object('group', v_group_name, 'description', v_description,
                         'accepted', p_accept, 'note', NULLIF(btrim(p_note), '')),
      'dispute:' || p_dispute_id::text || ':resolved'
    );
  END IF;
END
$$;


--
-- Name: waves_restore_expense(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_restore_expense(p_expense_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id  uuid;
  v_member_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in this group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_member_id := public.waves_my_member_id(v_group_id);

  -- The 30-day window is enforced by the expenses_restore_window trigger.
  UPDATE public.expenses
     SET deleted_at = NULL, deleted_by = NULL
   WHERE id = p_expense_id;

  INSERT INTO public.activity_log (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_member_id, 'restored', 'expense', p_expense_id, '{}'::jsonb);
END
$$;


--
-- Name: waves_scans_used_this_month(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_scans_used_this_month(p_profile_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT count(*)::int
  FROM public.usage_events ue
  WHERE ue.profile_id = COALESCE(p_profile_id, public.waves_current_profile_id())
    AND ue.kind = 'receipt_scan'
    AND ue.created_at >= date_trunc('month', now());
$$;


--
-- Name: waves_set_category_budget(uuid, text, bigint, character); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_set_category_budget(p_group_id uuid, p_category text, p_amount_minor bigint DEFAULT NULL::bigint, p_currency character DEFAULT NULL::bpchar) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_currency char(3);
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN: only an admin sets a category budget'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'INVALID_CATEGORY: a category is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_amount_minor IS NOT NULL AND p_amount_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: a budget is zero or more'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  IF p_amount_minor IS NULL THEN
    -- Clear: drop the key, leaving an empty object rather than NULL so the
    -- column's type stays an object.
    UPDATE public.groups SET
      category_budgets = COALESCE(category_budgets, '{}'::jsonb) - p_category,
      updated_at       = now()
    WHERE id = p_group_id;
  ELSE
    UPDATE public.groups SET
      category_budgets = jsonb_set(
        COALESCE(category_budgets, '{}'::jsonb),
        ARRAY[p_category],
        jsonb_build_object(
          'amountMinor', p_amount_minor::text,
          'currency', upper(v_currency)
        ),
        true
      ),
      updated_at = now()
    WHERE id = p_group_id;
  END IF;
END
$$;


--
-- Name: waves_set_group_budget(uuid, bigint, character); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_set_group_budget(p_group_id uuid, p_amount_minor bigint DEFAULT NULL::bigint, p_currency character DEFAULT NULL::bpchar) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_currency char(3);
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN: only an admin sets the overall budget'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_amount_minor IS NOT NULL AND p_amount_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: a budget is zero or more'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  UPDATE public.groups SET
    budget_minor    = p_amount_minor,
    budget_currency = CASE WHEN p_amount_minor IS NULL THEN NULL ELSE upper(v_currency) END,
    updated_at      = now()
  WHERE id = p_group_id;
END
$$;


--
-- Name: waves_set_group_fx_rate(uuid, character, bigint, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_set_group_fx_rate(p_group_id uuid, p_from character, p_num bigint DEFAULT NULL::bigint, p_den bigint DEFAULT NULL::bigint, p_source text DEFAULT 'manual'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_default char(3);
  v_from    char(3);
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN: only an admin sets a trip rate'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_from := upper(p_from);

  SELECT default_currency INTO v_default FROM public.groups WHERE id = p_group_id;
  IF v_default IS NULL THEN
    RAISE EXCEPTION 'NO_SUCH_GROUP' USING ERRCODE = 'no_data_found';
  END IF;

  -- A group never converts its own settle currency: that "rate" is always 1 and
  -- storing it would only give the resolver a wrong-direction entry to trip on.
  IF v_from = v_default THEN
    RAISE EXCEPTION 'SAME_CURRENCY: a trip rate converts a foreign currency into %, not itself', v_default
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_num IS NULL OR p_den IS NULL THEN
    -- Clear this currency's entry, leaving an empty object rather than NULL so
    -- the column's type stays an object.
    UPDATE public.groups SET
      fx_rates   = COALESCE(fx_rates, '{}'::jsonb) - v_from,
      updated_at = now()
    WHERE id = p_group_id;
    RETURN;
  END IF;

  -- A rate is two positive integers; anything else is not a rate.
  IF p_num <= 0 OR p_den <= 0 THEN
    RAISE EXCEPTION 'INVALID_RATE: a rate is a ratio of two positive integers'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.groups SET
    fx_rates = jsonb_set(
      COALESCE(fx_rates, '{}'::jsonb),
      ARRAY[v_from],
      jsonb_build_object(
        'num', p_num::text,
        'den', p_den::text,
        'ts', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'source', COALESCE(NULLIF(btrim(p_source), ''), 'manual')
      ),
      true
    ),
    updated_at = now()
  WHERE id = p_group_id;
END
$$;


--
-- Name: waves_set_item_claim(uuid, integer, boolean, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_set_item_claim(p_receipt_id uuid, p_item_index integer, p_claimed boolean, p_for_member_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
  v_member   uuid;
  v_revision int;
  v_ghost    boolean;
BEGIN
  SELECT group_id INTO v_group_id FROM public.receipts WHERE id = p_receipt_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such receipt' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_item_index < 0 THEN
    RAISE EXCEPTION 'INVALID_ITEM: an item index is not negative'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_for_member_id IS NULL THEN
    v_member := public.waves_my_member_id(v_group_id);
    IF v_member IS NULL THEN
      RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    SELECT (profile_id IS NULL) INTO v_ghost
    FROM public.group_members
    WHERE id = p_for_member_id AND group_id = v_group_id AND left_at IS NULL;

    IF v_ghost IS NULL THEN
      RAISE EXCEPTION 'UNKNOWN_MEMBER: that person is not in this group'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NOT v_ghost THEN
      -- The whole point of the CRDT is that everybody claims their own lines.
      -- Letting one phone claim for another is how a set of facts turns back
      -- into one person's opinion, and it is the `actor_member_id` bug wearing
      -- a different hat.
      RAISE EXCEPTION 'NOT_YOURS: they are on Waves — they claim their own lines'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_member := p_for_member_id;
  END IF;

  -- One statement, so two devices racing on the same row serialise in the
  -- database rather than in whichever of them read first.
  INSERT INTO public.receipt_item_claims (receipt_id, item_index, member_id, released_at, revision)
  VALUES (
    p_receipt_id, p_item_index, v_member,
    CASE WHEN p_claimed THEN NULL ELSE now() END,
    1
  )
  ON CONFLICT (receipt_id, item_index, member_id) DO UPDATE
    SET released_at = CASE WHEN p_claimed THEN NULL ELSE now() END,
        revision    = public.receipt_item_claims.revision + 1,
        updated_at  = now()
  RETURNING revision INTO v_revision;

  RETURN jsonb_build_object(
    'receiptId', p_receipt_id,
    'itemIndex', p_item_index,
    'memberId', v_member,
    'claimed', p_claimed,
    'revision', v_revision
  );
END
$$;


--
-- Name: waves_set_member_role(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_set_member_role(p_member_id uuid, p_role text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id   uuid;
  v_profile_id uuid;
  v_old_role   public."MemberRole";
  v_admins     int;
BEGIN
  SELECT group_id, profile_id, role
    INTO v_group_id, v_profile_id, v_old_role
  FROM public.group_members WHERE id = p_member_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such member' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.is_group_admin(v_group_id) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN: only an admin changes another member''s role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'INVALID_ROLE: admin or member' USING ERRCODE = 'check_violation';
  END IF;

  -- A ghost has no login; an admin ghost is authority nobody holds.
  IF p_role = 'admin' AND v_profile_id IS NULL THEN
    RAISE EXCEPTION 'GHOST_CANNOT_ADMIN: a ghost has no account to act with'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Never demote the last admin — a group with no admin can promote nobody.
  IF p_role = 'member' AND v_old_role = 'admin' THEN
    SELECT count(*) INTO v_admins
    FROM public.group_members
    WHERE group_id = v_group_id AND role = 'admin' AND left_at IS NULL;
    IF v_admins <= 1 THEN
      RAISE EXCEPTION 'LAST_ADMIN: a group keeps at least one admin'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE public.group_members
     SET role = p_role::public."MemberRole",
         updated_at = now()
   WHERE id = p_member_id;
END
$$;


--
-- Name: waves_set_my_trip_budget(uuid, bigint, character, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_set_my_trip_budget(p_group_id uuid, p_amount_minor bigint, p_currency character DEFAULT NULL::bpchar, p_visibility text DEFAULT 'private'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_member   uuid;
  v_currency char(3);
  v_id       uuid;
BEGIN
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_member := public.waves_my_member_id(p_group_id);
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you have no membership here'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_amount_minor IS NULL OR p_amount_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: a budget is zero or more'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_visibility NOT IN ('private', 'group') THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY: private or group'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(p_currency, default_currency) INTO v_currency
  FROM public.groups WHERE id = p_group_id;

  INSERT INTO public.trip_member_budgets
    (group_id, member_id, amount_minor, currency, visibility)
  VALUES
    (p_group_id, v_member, p_amount_minor, upper(v_currency), p_visibility)
  ON CONFLICT (member_id) DO UPDATE
    SET amount_minor = EXCLUDED.amount_minor,
        currency     = EXCLUDED.currency,
        visibility   = EXCLUDED.visibility,
        deleted_at   = NULL,
        updated_at   = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_settlement_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_settlement_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'initiated'  AND NEW.status IN ('confirmed', 'auto_confirmed', 'disputed', 'cancelled'))
    OR (OLD.status = 'auto_confirmed' AND NEW.status = 'disputed')
    OR (OLD.status = 'disputed' AND NEW.status IN ('confirmed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: settlement cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('confirmed', 'auto_confirmed') AND NEW.confirmed_at IS NULL THEN
    NEW.confirmed_at := now();
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: waves_shares_a_group_with(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_shares_a_group_with(p_profile_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p_profile_id IS NOT NULL
     AND (
       -- Your own face, always.
       p_profile_id = public.waves_current_profile_id()
       OR EXISTS (
         SELECT 1
         FROM public.group_members mine
         JOIN public.group_members theirs ON theirs.group_id = mine.group_id
         WHERE mine.profile_id = public.waves_current_profile_id()
           AND theirs.profile_id = p_profile_id
           AND mine.left_at IS NULL
       )
     )
$$;


--
-- Name: waves_sign_out_other_devices(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_sign_out_other_devices(p_device_id text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
  v_count   int;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN: only a signed-in account has devices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.device_sessions
  SET revoked_at = now()
  WHERE profile_id = v_profile
    AND device_id <> p_device_id
    AND revoked_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;


--
-- Name: waves_stamp_capture_seq(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_stamp_capture_seq() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_seq := public.waves_next_capture_seq(NEW.owner_user_id);
  RETURN NEW;
END
$$;


--
-- Name: waves_stamp_category_tag_seq(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_stamp_category_tag_seq() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_seq := public.waves_next_category_tag_seq(NEW.owner_user_id);
  RETURN NEW;
END
$$;


--
-- Name: waves_stamp_ghost_merge_seq(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_stamp_ghost_merge_seq() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_seq := public.waves_next_ghost_merge_seq(NEW.owner);
  RETURN NEW;
END
$$;


--
-- Name: waves_stamp_group_seq(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_stamp_group_seq() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- `waves_next_group_seq` bumps this column directly; when it does, NEW is
  -- already ahead of OLD and there is nothing left to do. Any other update —
  -- a rename, an archive — arrives with the two equal and needs a bump.
  IF NEW.updated_seq IS NOT DISTINCT FROM OLD.updated_seq THEN
    NEW.updated_seq := OLD.updated_seq + 1;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: waves_stamp_personal_seq(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_stamp_personal_seq() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_seq := public.waves_next_personal_seq(NEW.owner_user_id);
  RETURN NEW;
END
$$;


--
-- Name: waves_stamp_seq(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_stamp_seq() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_seq := public.waves_next_group_seq(NEW.group_id);
  RETURN NEW;
END
$$;


--
-- Name: waves_storage_counts(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_counts(p_profile_id uuid, p_group_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT NOT public.waves_profile_is_paid(p_profile_id)
     AND NOT (p_group_id IS NOT NULL AND public.waves_group_is_paid(p_group_id));
$$;


--
-- Name: waves_storage_enqueue_orphan(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_enqueue_orphan() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.storage_orphans (logical_bucket, path)
  VALUES (OLD.logical_bucket, OLD.path)
  ON CONFLICT (logical_bucket, path) DO NOTHING;
  RETURN OLD;
END
$$;


--
-- Name: waves_storage_expire_pending(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_expire_pending(p_age interval DEFAULT '00:30:00'::interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_count integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.storage_objects
     WHERE pending AND updated_at <= now() - p_age
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM gone;
  RETURN v_count;
END
$$;


--
-- Name: waves_storage_orphan_clear(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_orphan_clear(p_logical_bucket text, p_path text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  DELETE FROM public.storage_orphans
   WHERE logical_bucket = p_logical_bucket AND path = p_path;
$$;


--
-- Name: waves_storage_orphans(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_orphans(p_limit integer DEFAULT 100) RETURNS TABLE(logical_bucket text, path text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT logical_bucket, path
    FROM public.storage_orphans
   ORDER BY enqueued_at
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 1000));
$$;


--
-- Name: waves_storage_record(uuid, uuid, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_record(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text DEFAULT 'image/webp'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_counted boolean;
  v_used    bigint;
BEGIN
  IF p_profile_id IS NULL OR p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'STORAGE_BAD_INPUT' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  v_counted := public.waves_storage_counts(p_profile_id, p_group_id);

  IF v_counted THEN
    -- The true-size cap check, excluding this same object so a replacement
    -- measures the delta, not double.
    SELECT COALESCE(SUM(bytes), 0) INTO v_used
      FROM public.storage_objects
     WHERE owner_profile_id = p_profile_id
       AND counted
       AND NOT (logical_bucket = p_logical_bucket AND path = p_path);

    -- Reject only a *new* object over the ceiling. A replacement of an object
    -- already committed at this path is recorded honestly even if its true size
    -- lands over the cap: the reserve gate already checked its declared size, the
    -- bytes are already sitting at the stable key, and counting them (the tally
    -- may then sit over the cap, which blocks any *further* upload) is safer than
    -- rejecting — which would leave a readable object the cap cannot see. A
    -- replacement adds no new object, so this cannot be a fill vector.
    IF v_used + p_bytes > public.waves_free_storage_cap()
       AND NOT EXISTS (
         SELECT 1 FROM public.storage_objects
          WHERE logical_bucket = p_logical_bucket AND path = p_path AND NOT pending
       )
    THEN
      RAISE EXCEPTION 'STORAGE_CAP'
        USING ERRCODE = 'check_violation',
              HINT = 'You have reached your free storage limit; upgrade to add more.';
    END IF;
  END IF;

  INSERT INTO public.storage_objects
    (logical_bucket, path, owner_profile_id, group_id, bytes, content_type, counted, pending)
  VALUES
    (p_logical_bucket, p_path, p_profile_id, p_group_id, p_bytes, p_content_type, v_counted, false)
  ON CONFLICT (logical_bucket, path) DO UPDATE
    SET owner_profile_id = excluded.owner_profile_id,
        group_id         = excluded.group_id,
        bytes            = excluded.bytes,
        content_type     = excluded.content_type,
        counted          = excluded.counted,
        pending          = false,
        updated_at       = now();
END
$$;


--
-- Name: waves_storage_recount(text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_recount(p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text DEFAULT 'image/webp'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'STORAGE_BAD_INPUT' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.storage_objects
     SET bytes        = p_bytes,
         content_type = p_content_type,
         counted      = public.waves_storage_counts(owner_profile_id, group_id),
         updated_at   = now()
   WHERE logical_bucket = p_logical_bucket
     AND path = p_path
     AND NOT pending;
END
$$;


--
-- Name: waves_storage_release(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_release(p_logical_bucket text, p_path text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  DELETE FROM public.storage_objects
   WHERE logical_bucket = p_logical_bucket AND path = p_path;
$$;


--
-- Name: waves_storage_release_reservation(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_release_reservation(p_logical_bucket text, p_path text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.storage_objects
   WHERE logical_bucket = p_logical_bucket AND path = p_path AND pending;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END
$$;


--
-- Name: waves_storage_reserve(uuid, uuid, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_storage_reserve(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text DEFAULT 'image/webp'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_counted       boolean;
  v_used          bigint;
  v_pending_count integer;
BEGIN
  IF p_profile_id IS NULL OR p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'STORAGE_BAD_INPUT' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialise every reserve/commit for this owner so the cap check and the write
  -- are one indivisible step.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  v_counted := public.waves_storage_counts(p_profile_id, p_group_id);

  IF v_counted THEN
    -- Bound abandoned reservations (see the note above). A re-reservation of the
    -- same object is a replacement, not a new pending, so it is excluded.
    SELECT count(*) INTO v_pending_count
      FROM public.storage_objects
     WHERE owner_profile_id = p_profile_id
       AND pending
       AND NOT (logical_bucket = p_logical_bucket AND path = p_path);
    IF v_pending_count >= 8 THEN
      RAISE EXCEPTION 'STORAGE_TOO_MANY_PENDING'
        USING ERRCODE = 'check_violation',
              HINT = 'Too many uploads in flight; finish or wait a moment.';
    END IF;

    SELECT COALESCE(SUM(bytes), 0) INTO v_used
      FROM public.storage_objects
     WHERE owner_profile_id = p_profile_id
       AND counted
       AND NOT (logical_bucket = p_logical_bucket AND path = p_path);

    IF v_used + p_bytes > public.waves_free_storage_cap() THEN
      RAISE EXCEPTION 'STORAGE_CAP'
        USING ERRCODE = 'check_violation',
              HINT = 'You have reached your free storage limit; upgrade to add more.';
    END IF;
  END IF;

  INSERT INTO public.storage_objects
    (logical_bucket, path, owner_profile_id, group_id, bytes, content_type, counted, pending)
  VALUES
    (p_logical_bucket, p_path, p_profile_id, p_group_id, p_bytes, p_content_type, v_counted, true)
  ON CONFLICT (logical_bucket, path) DO UPDATE
    SET owner_profile_id = excluded.owner_profile_id,
        group_id         = excluded.group_id,
        bytes            = excluded.bytes,
        content_type     = excluded.content_type,
        counted          = excluded.counted,
        pending          = true,
        updated_at       = now()
    -- Only ever refresh an existing *reservation*. A committed object at this
    -- path (a replacement) is left exactly as it is: its row must not flip to
    -- pending, because if this upload is then abandoned or refused the failure
    -- cleanup would delete the row and strand — or destroy — the good image that
    -- is already there. The cap check above already excludes this same path, so a
    -- replacement is still measured as a delta; only the write is withheld.
    WHERE storage_objects.pending;
END
$$;


--
-- Name: waves_submit_feedback(text, text, integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_submit_feedback(p_message text, p_kind text DEFAULT 'general'::text, p_rating integer DEFAULT NULL::integer, p_app_version text DEFAULT NULL::text, p_platform text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
  v_id uuid;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;
  IF length(trim(COALESCE(p_message, ''))) = 0 THEN
    RAISE EXCEPTION 'EMPTY_MESSAGE';
  END IF;

  INSERT INTO public.feedback
    (profile_id, kind, message, rating, app_version, platform, locale, country_code)
  SELECT
    v_profile,
    COALESCE(p_kind, 'general'),
    left(trim(p_message), 4000),
    p_rating,
    p_app_version,
    p_platform,
    p.locale,
    p.country_code
  FROM public.profiles p
  WHERE p.id = v_profile
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;


--
-- Name: waves_suppress_email(text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_suppress_email(p_address text, p_reason text, p_detail jsonb DEFAULT '{}'::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_address text := lower(trim(COALESCE(p_address, '')));
BEGIN
  IF v_address = '' THEN
    RETURN FALSE;
  END IF;

  -- First reason wins. An address that hard-bounced and later gets an
  -- unsubscribe is still suppressed for the bounce, and that is the reason
  -- worth keeping.
  INSERT INTO public.email_suppressions (address, reason, detail)
  VALUES (v_address, p_reason, COALESCE(p_detail, '{}'::jsonb))
  ON CONFLICT (address) DO NOTHING;

  RETURN TRUE;
END
$$;


--
-- Name: waves_sweep_rate_limits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_sweep_rate_limits() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.rate_limit_hits
   WHERE window_start < now() - interval '1 day';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: waves_touch_balances(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_touch_balances() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
BEGIN
  IF TG_TABLE_NAME IN ('expenses', 'settlements') THEN
    IF TG_OP = 'DELETE' THEN
      v_group_id := OLD.group_id;
    ELSE
      v_group_id := NEW.group_id;
    END IF;
  ELSIF TG_TABLE_NAME IN ('expense_payers', 'expense_shares') THEN
    IF TG_OP = 'DELETE' THEN
      v_group_id := public.waves_version_group_id(OLD.expense_version_id);
    ELSE
      v_group_id := public.waves_version_group_id(NEW.expense_version_id);
    END IF;
  END IF;

  IF v_group_id IS NOT NULL THEN
    PERFORM public.waves_refresh_group_balances(v_group_id);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: waves_trip_nudges(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_trip_nudges(p_now timestamp with time zone DEFAULT now()) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
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

      v_id := public.waves_notify(
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
        'waves://group/' || v_group.id::text || '/add-expense',
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


--
-- Name: waves_update_plan_item(uuid, date, time without time zone, text, text, text, bigint, boolean, uuid, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_update_plan_item(p_item_id uuid, p_day date DEFAULT NULL::date, p_starts_at time without time zone DEFAULT NULL::time without time zone, p_title text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_planned_minor bigint DEFAULT NULL::bigint, p_done boolean DEFAULT NULL::boolean, p_expense_id uuid DEFAULT NULL::uuid, p_clear text[] DEFAULT '{}'::text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT group_id INTO v_group_id FROM public.trip_plan_items WHERE id = p_item_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such plan item' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.is_group_member(v_group_id) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER: you are not in that group'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- An expense can only ever be one from this same group. Otherwise a plan item
  -- could point at a stranger's expense and leak its description through the
  -- join the app makes.
  IF p_expense_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expenses WHERE id = p_expense_id AND group_id = v_group_id
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_EXPENSE: that expense is not in this group'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  UPDATE public.trip_plan_items SET
    day           = COALESCE(p_day, day),
    starts_at     = CASE WHEN 'starts_at' = ANY(p_clear) THEN NULL
                         ELSE COALESCE(p_starts_at, starts_at) END,
    title         = COALESCE(NULLIF(btrim(COALESCE(p_title, '')), ''), title),
    note          = CASE WHEN 'note' = ANY(p_clear) THEN NULL ELSE COALESCE(p_note, note) END,
    category      = CASE WHEN 'category' = ANY(p_clear) THEN NULL
                         ELSE COALESCE(p_category, category) END,
    planned_minor = CASE WHEN 'planned_minor' = ANY(p_clear) THEN NULL
                         ELSE COALESCE(p_planned_minor, planned_minor) END,
    done_at       = CASE WHEN p_done IS NULL THEN done_at
                         WHEN p_done THEN COALESCE(done_at, now())
                         ELSE NULL END,
    expense_id    = CASE WHEN 'expense_id' = ANY(p_clear) THEN NULL
                         ELSE COALESCE(p_expense_id, expense_id) END,
    updated_at    = now()
  WHERE id = p_item_id;
END
$$;


--
-- Name: waves_variant(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_variant(p_key text, p_profile_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_flag public.feature_flags%ROWTYPE;
  v_arms integer;
BEGIN
  SELECT * INTO v_flag FROM public.feature_flags WHERE key = p_key;
  IF NOT FOUND OR NOT v_flag.enabled OR p_profile_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_arms := array_length(v_flag.variants, 1);
  IF v_arms IS NULL OR v_arms < 2 THEN
    RETURN NULL;
  END IF;

  IF public.waves_bucket(p_key || ':' || p_profile_id::text) >= v_flag.rollout_percent THEN
    RETURN NULL;
  END IF;

  -- 1-based, so this matches the TypeScript's `variants[bucket % length]`.
  RETURN v_flag.variants[
    1 + (public.waves_bucket(p_key || ':' || p_profile_id::text || ':variant') % v_arms)
  ];
END
$$;


--
-- Name: waves_version_group_id(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_version_group_id(p_version_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT e.group_id
  FROM public.expense_versions ev
  JOIN public.expenses e ON e.id = ev.expense_id
  WHERE ev.id = p_version_id
$$;


--
-- Name: waves_version_key(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_version_key(p_version text) RETURNS integer[]
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'public', 'pg_temp'
    AS $$
  -- Padded to four segments so `1.2` and `1.2.0.0` compare equal, matching
  -- `compareVersions` in @waves/core. Postgres compares int[] element-wise.
  SELECT (string_to_array(p_version, '.') || ARRAY['0', '0', '0', '0'])[1:4]::int[]
$$;


--
-- Name: FUNCTION waves_version_key(p_version text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.waves_version_key(p_version text) IS 'Dotted version as a comparable int[]. Mirrors compareVersions in @waves/core.';


--
-- Name: waves_voice_stt_free_seconds(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_voice_stt_free_seconds() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT COALESCE((SELECT value FROM public.app_config WHERE key = 'voice_stt_free_seconds'), 300);
$$;


--
-- Name: waves_voice_stt_record(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_voice_stt_record(p_profile uuid, p_seconds integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_total  integer;
BEGIN
  IF p_seconds IS NULL OR p_seconds < 0 THEN
    RAISE EXCEPTION 'VOICE_STT_BAD_SECONDS';
  END IF;
  INSERT INTO public.voice_stt_usage (profile_id, period, seconds, updated_at)
  VALUES (p_profile, v_period, p_seconds, now())
  ON CONFLICT (profile_id, period) DO UPDATE
    SET seconds = public.voice_stt_usage.seconds + EXCLUDED.seconds,
        updated_at = now()
  RETURNING seconds INTO v_total;
  RETURN v_total;
END;
$$;


--
-- Name: waves_voice_stt_remaining_seconds(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_voice_stt_remaining_seconds(p_profile uuid) RETURNS integer
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_free   integer;
  v_used   integer;
BEGIN
  IF public.waves_profile_is_paid(p_profile) THEN
    RETURN NULL; -- unlimited
  END IF;
  v_free := public.waves_voice_stt_free_seconds();
  SELECT seconds INTO v_used
    FROM public.voice_stt_usage
   WHERE profile_id = p_profile AND period = v_period;
  RETURN GREATEST(0, v_free - COALESCE(v_used, 0));
END;
$$;


--
-- Name: waves_withdraw_dispute(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_withdraw_dispute(p_expense_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_group_id UUID;
  v_actor    UUID;
  v_updated  INTEGER;
BEGIN
  SELECT group_id INTO v_group_id FROM public.expenses WHERE id = p_expense_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no such expense' USING ERRCODE = 'no_data_found';
  END IF;

  v_actor := public.waves_my_member_id(v_group_id);

  UPDATE public.expense_disputes
     SET status = 'withdrawn', resolved_at = now(), updated_at = now(),
         resolved_by_member_id = v_actor
   WHERE expense_id = p_expense_id AND member_id = v_actor AND status = 'open';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RAISE EXCEPTION 'NOT_YOUR_DISPUTE: you have no open dispute on this expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.activity_log
    (group_id, actor_member_id, verb, object_type, object_id, payload)
  VALUES (v_group_id, v_actor, 'withdrew_dispute', 'expense', p_expense_id, '{}'::jsonb);
END
$$;


--
-- Name: waves_withdraw_member_claim(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.waves_withdraw_member_claim(p_claim_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_profile uuid := public.waves_current_profile_id();
  v_rows    integer;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;

  UPDATE public.member_claims
     SET status = 'withdrawn', decided_at = now()
   WHERE id = p_claim_id
     AND requester_id = v_profile
     AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_rows = 1);
END
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    actor_member_id uuid,
    verb text NOT NULL,
    object_type text NOT NULL,
    object_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key text NOT NULL,
    value integer NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_config_key_shape CHECK ((key ~ '^[a-z][a-z0-9_]{1,60}$'::text)),
    CONSTRAINT app_config_value_nonneg CHECK ((value >= 0))
);


--
-- Name: app_releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_releases (
    platform text NOT NULL,
    latest_version text NOT NULL,
    minimum_version text NOT NULL,
    store_url text NOT NULL,
    message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_releases_latest_version_check CHECK ((latest_version ~ '^[0-9]+(\.[0-9]+){0,3}$'::text)),
    CONSTRAINT app_releases_minimum_not_above_latest CHECK ((public.waves_version_key(minimum_version) <= public.waves_version_key(latest_version))),
    CONSTRAINT app_releases_minimum_version_check CHECK ((minimum_version ~ '^[0-9]+(\.[0-9]+){0,3}$'::text)),
    CONSTRAINT app_releases_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text]))),
    CONSTRAINT app_releases_store_url_check CHECK ((length(store_url) > 0))
);


--
-- Name: TABLE app_releases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.app_releases IS 'Per-store version policy. Public read, service-role write.';


--
-- Name: campaign_email_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_email_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    address text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    resend_email_id text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_email_sends_address_present CHECK ((address <> ''::text)),
    CONSTRAINT campaign_email_sends_status_known CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: campaign_impressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_impressions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    acted_at timestamp with time zone
);


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    cta_label text DEFAULT ''::text NOT NULL,
    promo_code text,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    audience_countries text[],
    holdout_percent integer DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaigns_holdout_range CHECK (((holdout_percent >= 0) AND (holdout_percent <= 90))),
    CONSTRAINT campaigns_title_present CHECK ((length(TRIM(BOTH FROM title)) > 0)),
    CONSTRAINT campaigns_window CHECK ((ends_at > starts_at))
);


--
-- Name: captures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.captures (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category text,
    expense_date date NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    notes text,
    photo_path text,
    raw_text text,
    parsed jsonb,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_expense_id uuid,
    assigned_group_id uuid,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(6) with time zone,
    payment_method text,
    target_group_id uuid,
    category_meta jsonb,
    location jsonb,
    CONSTRAINT captures_amount_nonneg CHECK ((amount >= 0)),
    CONSTRAINT captures_status_check CHECK ((status = ANY (ARRAY['open'::text, 'assigned'::text])))
);


--
-- Name: category_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.category_tags (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    builtin_id text,
    label text,
    icon text,
    tint text,
    sort_order integer DEFAULT 0 NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(6) with time zone,
    CONSTRAINT category_tags_custom_has_label CHECK (((builtin_id IS NOT NULL) OR (label IS NOT NULL)))
);


--
-- Name: country_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.country_settings (
    code character(2) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT country_settings_code_shape CHECK ((code ~ '^[A-Z]{2}$'::text))
);


--
-- Name: device_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    device_id text NOT NULL,
    label text DEFAULT 'This device'::text NOT NULL,
    platform text DEFAULT 'unknown'::text NOT NULL,
    app_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: email_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid,
    profile_id uuid NOT NULL,
    resend_email_id text,
    template text NOT NULL,
    event text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: email_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_suppressions (
    address text NOT NULL,
    reason text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_suppressions_address_normalised CHECK (((address = lower(address)) AND (address <> ''::text))),
    CONSTRAINT email_suppressions_reason_known CHECK ((reason = ANY (ARRAY['bounced'::text, 'complained'::text, 'unsubscribed'::text])))
);


--
-- Name: expense_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_id uuid NOT NULL,
    group_id uuid NOT NULL,
    uploader_member_id uuid NOT NULL,
    storage_path text NOT NULL,
    visibility text DEFAULT 'group'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    annotations jsonb,
    CONSTRAINT expense_attachments_annotations_sane CHECK (((annotations IS NULL) OR (pg_column_size(annotations) <= 262144))),
    CONSTRAINT expense_attachments_path_present CHECK ((btrim(storage_path) <> ''::text)),
    CONSTRAINT expense_attachments_visibility_check CHECK ((visibility = ANY (ARRAY['group'::text, 'parties'::text])))
);


--
-- Name: expense_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    expense_id uuid NOT NULL,
    author_member_id uuid,
    body text NOT NULL,
    edited_at timestamp with time zone,
    flagged_at timestamp with time zone,
    flagged_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT expense_comments_body_present CHECK ((btrim(body) <> ''::text)),
    CONSTRAINT expense_comments_body_sane CHECK ((char_length(body) <= 2000))
);


--
-- Name: expense_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_id uuid NOT NULL,
    member_id uuid NOT NULL,
    reason text,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_by_member_id uuid,
    resolution_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT expense_disputes_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'withdrawn'::text, 'rejected'::text])))
);


--
-- Name: TABLE expense_disputes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.expense_disputes IS 'Somebody saying an expense is wrong. Visible to the group; never changes a balance on its own.';


--
-- Name: expense_image_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_image_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    expense_id uuid NOT NULL,
    actor_member_id uuid,
    kind text NOT NULL,
    action text NOT NULL,
    visibility text DEFAULT 'group'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT expense_image_events_action_ck CHECK ((action = ANY (ARRAY['added'::text, 'removed'::text]))),
    CONSTRAINT expense_image_events_kind_ck CHECK ((kind = ANY (ARRAY['receipt'::text, 'attachment'::text]))),
    CONSTRAINT expense_image_events_visibility_ck CHECK ((visibility = ANY (ARRAY['group'::text, 'parties'::text])))
);


--
-- Name: expense_payers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_payers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_version_id uuid NOT NULL,
    member_id uuid NOT NULL,
    amount bigint NOT NULL,
    CONSTRAINT expense_payers_amount_non_negative CHECK ((amount >= 0))
);


--
-- Name: expense_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_version_id uuid NOT NULL,
    member_id uuid NOT NULL,
    amount bigint NOT NULL
);


--
-- Name: expense_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_id uuid NOT NULL,
    version_no integer NOT NULL,
    author_member_id uuid,
    description text NOT NULL,
    category text,
    expense_date date NOT NULL,
    currency character(3) NOT NULL,
    amount bigint NOT NULL,
    split_type public."SplitType" NOT NULL,
    split_params jsonb NOT NULL,
    fx jsonb,
    receipt_id uuid,
    notes text,
    client_mutation_id uuid,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    source public."ExpenseSource" DEFAULT 'manual'::public."ExpenseSource" NOT NULL,
    payment_method text,
    receipt_share_url text,
    category_meta jsonb,
    location jsonb,
    CONSTRAINT expense_versions_amount_non_negative CHECK ((amount >= 0)),
    CONSTRAINT expense_versions_currency_upper CHECK (((currency)::text = upper((currency)::text))),
    CONSTRAINT expense_versions_version_no_positive CHECK ((version_no >= 1))
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    current_version_id uuid,
    created_by uuid,
    deleted_at timestamp(6) with time zone,
    deleted_by uuid,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.expenses REPLICA IDENTITY FULL;


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    key text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    rollout_percent integer DEFAULT 0 NOT NULL,
    variants text[] DEFAULT ARRAY['control'::text, 'treatment'::text] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feature_flags_key_shape CHECK ((key ~ '^[a-z][a-z0-9_]{1,60}$'::text)),
    CONSTRAINT feature_flags_rollout_range CHECK (((rollout_percent >= 0) AND (rollout_percent <= 100))),
    CONSTRAINT feature_flags_variant_count CHECK (((array_length(variants, 1) >= 2) AND (array_length(variants, 1) <= 8))),
    CONSTRAINT feature_flags_variants_distinct CHECK (public.waves_array_is_distinct(variants))
);


--
-- Name: feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid,
    kind text DEFAULT 'general'::text NOT NULL,
    message text NOT NULL,
    rating integer,
    app_version text,
    platform text,
    locale text,
    country_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feedback_kind_known CHECK ((kind = ANY (ARRAY['general'::text, 'bug'::text, 'idea'::text, 'deletion'::text]))),
    CONSTRAINT feedback_message_present CHECK (((length(TRIM(BOTH FROM message)) >= 1) AND (length(TRIM(BOTH FROM message)) <= 4000))),
    CONSTRAINT feedback_rating_range CHECK (((rating IS NULL) OR ((rating >= 1) AND (rating <= 5))))
);


--
-- Name: ghost_merges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ghost_merges (
    owner uuid NOT NULL,
    member_id uuid NOT NULL,
    person_id uuid NOT NULL,
    display_name text NOT NULL,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL
);


--
-- Name: group_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_balances (
    group_id uuid NOT NULL,
    member_id uuid NOT NULL,
    currency character(3) NOT NULL,
    balance bigint DEFAULT 0 NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.group_balances REPLICA IDENTITY FULL;


--
-- Name: group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    profile_id uuid,
    ghost_name text,
    role public."MemberRole" DEFAULT 'member'::public."MemberRole" NOT NULL,
    joined_via text,
    vpa text,
    left_at timestamp(6) with time zone,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    invite_email text,
    invite_phone text,
    payment_rail text,
    payment_handle text,
    CONSTRAINT group_members_invite_email_lowercase CHECK (((invite_email IS NULL) OR (invite_email = lower(invite_email)))),
    CONSTRAINT group_members_invite_email_shape CHECK (((invite_email IS NULL) OR (invite_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text))),
    CONSTRAINT group_members_invite_phone_e164 CHECK (((invite_phone IS NULL) OR (invite_phone ~ '^\+[1-9][0-9]{7,14}$'::text))),
    CONSTRAINT group_members_payment_rail_known CHECK (((payment_rail IS NULL) OR (payment_rail = ANY (ARRAY['upi'::text, 'pix'::text, 'paynow'::text, 'promptpay'::text, 'qris'::text, 'aani'::text, 'payid'::text, 'zelle'::text, 'venmo'::text, 'cashapp'::text, 'interac'::text, 'wise'::text, 'revolut'::text, 'paypal'::text, 'bank'::text, 'cash'::text, 'other'::text])))),
    CONSTRAINT group_members_profile_xor_ghost CHECK (((profile_id IS NULL) <> (ghost_name IS NULL)))
);


--
-- Name: COLUMN group_members.invite_email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.group_members.invite_email IS 'Where to send this person''s invite. Lowercased. Visible to the group.';


--
-- Name: COLUMN group_members.invite_phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.group_members.invite_phone IS 'E.164 only, e.g. +919876543210. Visible to the group.';


--
-- Name: group_passes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_passes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    purchased_by uuid,
    expires_at timestamp with time zone NOT NULL,
    store text DEFAULT 'play'::text NOT NULL,
    store_txn_id text,
    price_minor bigint,
    currency character(3),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_passes_store_known CHECK ((store = ANY (ARRAY['play'::text, 'appstore'::text, 'promo'::text])))
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    type public."GroupType" DEFAULT 'other'::public."GroupType" NOT NULL,
    default_currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    simplify_debts boolean DEFAULT true NOT NULL,
    cover_emoji text,
    archived_at timestamp(6) with time zone,
    created_by uuid,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    photo_path text,
    start_date date,
    end_date date,
    time_zone text DEFAULT 'Asia/Kolkata'::text NOT NULL,
    remind_daily boolean DEFAULT true NOT NULL,
    remind_morning_at time without time zone DEFAULT '09:00:00'::time without time zone NOT NULL,
    remind_evening_at time without time zone DEFAULT '21:00:00'::time without time zone NOT NULL,
    country_code character(2),
    budget_minor bigint,
    budget_currency character(3),
    category_budgets jsonb,
    join_token text,
    deleted_at timestamp(6) with time zone,
    fx_rates jsonb,
    CONSTRAINT groups_budget_sane CHECK (((budget_minor IS NULL) OR (budget_minor >= 0))),
    CONSTRAINT groups_category_budgets_object CHECK (((category_budgets IS NULL) OR (jsonb_typeof(category_budgets) = 'object'::text))),
    CONSTRAINT groups_country_code_shape CHECK (((country_code IS NULL) OR (country_code ~ '^[A-Z]{2}$'::text))),
    CONSTRAINT groups_currency_upper CHECK (((default_currency)::text = upper((default_currency)::text))),
    CONSTRAINT groups_dates_in_order CHECK (((start_date IS NULL) OR (end_date IS NULL) OR (start_date <= end_date))),
    CONSTRAINT groups_name_not_blank CHECK (((name IS NULL) OR (btrim(name) <> ''::text)))
);


--
-- Name: COLUMN groups.time_zone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.groups.time_zone IS 'IANA zone the reminders are scheduled in. A trip has a place; breakfast means breakfast there.';


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_by uuid,
    expires_at timestamp(6) with time zone NOT NULL,
    revoked_at timestamp(6) with time zone,
    max_uses integer DEFAULT 50 NOT NULL,
    use_count integer DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: member_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    member_id uuid NOT NULL,
    requester_id uuid NOT NULL,
    requested_name text,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_claims_decided_shape CHECK (((status = 'pending'::text) = (decided_at IS NULL))),
    CONSTRAINT member_claims_status_known CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'withdrawn'::text])))
);


--
-- Name: TABLE member_claims; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.member_claims IS 'Somebody asking to take over a ghost member. Decided by a group admin (ADR-006).';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    group_id uuid,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    deep_link text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    channels text[],
    push_status public."DeliveryStatus",
    email_status public."DeliveryStatus",
    read_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    dedupe_key text,
    push_attempts integer DEFAULT 0 NOT NULL,
    push_next_retry_at timestamp with time zone
);


--
-- Name: COLUMN notifications.dedupe_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.dedupe_key IS 'Idempotency for fanout: one row per (recipient, event). Retrying a send is a no-op.';


--
-- Name: pairwise_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pairwise_balances (
    group_id uuid NOT NULL,
    from_member_id uuid NOT NULL,
    to_member_id uuid NOT NULL,
    currency character(3) NOT NULL,
    amount bigint DEFAULT 0 NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: personal_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_records (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    record_kind text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(6) with time zone,
    CONSTRAINT personal_records_kind_known CHECK ((record_kind = ANY (ARRAY['txn'::text, 'recurring'::text, 'loan'::text, 'budget'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    display_name text NOT NULL,
    avatar_url text,
    default_vpa text,
    default_currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    notification_prefs jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    country_code character(2),
    payment_rail text,
    payment_handle text,
    captures_seq bigint DEFAULT 0 NOT NULL,
    ghost_merges_seq bigint DEFAULT 0 NOT NULL,
    address text,
    category_tags_seq bigint DEFAULT 0 NOT NULL,
    personal_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT profiles_country_code_shape CHECK (((country_code IS NULL) OR (country_code ~ '^[A-Z]{2}$'::text))),
    CONSTRAINT profiles_payment_rail_known CHECK (((payment_rail IS NULL) OR (payment_rail = ANY (ARRAY['upi'::text, 'pix'::text, 'paynow'::text, 'promptpay'::text, 'qris'::text, 'aani'::text, 'payid'::text, 'zelle'::text, 'venmo'::text, 'cashapp'::text, 'interac'::text, 'wise'::text, 'revolut'::text, 'paypal'::text, 'bank'::text, 'cash'::text, 'other'::text]))))
);


--
-- Name: promo_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_codes (
    code text NOT NULL,
    tier text DEFAULT 'plus'::text NOT NULL,
    days integer DEFAULT 30 NOT NULL,
    max_redemptions integer DEFAULT 1 NOT NULL,
    redeemed_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_codes_count_sane CHECK ((redeemed_count >= 0)),
    CONSTRAINT promo_codes_days_sane CHECK (((days >= 1) AND (days <= 3650))),
    CONSTRAINT promo_codes_max_sane CHECK (((max_redemptions >= 1) AND (max_redemptions <= 1000000))),
    CONSTRAINT promo_codes_shape CHECK ((code ~ '^[A-Z0-9]{4,24}$'::text)),
    CONSTRAINT promo_codes_tier_known CHECK ((tier = 'plus'::text))
);


--
-- Name: promo_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    profile_id uuid NOT NULL,
    subscription_id uuid,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: push_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    expo_push_token text NOT NULL,
    platform public."DevicePlatform" NOT NULL,
    device_name text,
    last_seen_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: rate_limit_hits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_hits (
    subject text NOT NULL,
    bucket text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    hits integer DEFAULT 0 NOT NULL,
    CONSTRAINT rate_limit_hits_hits_positive CHECK ((hits >= 0))
);


--
-- Name: rate_limit_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_rules (
    bucket text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    max_calls integer NOT NULL,
    window_seconds integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_limit_rules_max_calls_nonneg CHECK ((max_calls >= 0)),
    CONSTRAINT rate_limit_rules_window_positive CHECK ((window_seconds >= 1))
);


--
-- Name: rate_limit_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_settings (
    id boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_limit_settings_singleton CHECK (id)
);


--
-- Name: receipt_item_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_item_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_id uuid NOT NULL,
    item_index integer NOT NULL,
    member_id uuid NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    released_at timestamp with time zone,
    revision integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.receipt_item_claims REPLICA IDENTITY FULL;


--
-- Name: receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    storage_path text,
    source public."ReceiptSource" NOT NULL,
    raw_text text,
    parse_status public."ParseStatus" DEFAULT 'pending'::public."ParseStatus" NOT NULL,
    parsed jsonb,
    confidence jsonb,
    created_by uuid,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    from_member_id uuid NOT NULL,
    to_member_id uuid NOT NULL,
    due_date date,
    last_nudged_at timestamp(6) with time zone,
    auto boolean DEFAULT false NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT reminders_distinct_members CHECK ((from_member_id <> to_member_id))
);


--
-- Name: service_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_config (
    key text NOT NULL,
    value text,
    description text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: settlement_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    settlement_id uuid NOT NULL,
    expense_id uuid NOT NULL,
    amount bigint NOT NULL,
    CONSTRAINT settlement_allocations_amount_positive CHECK ((amount > 0))
);


--
-- Name: settlement_proofs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_proofs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    settlement_id uuid NOT NULL,
    group_id uuid NOT NULL,
    uploader_member_id uuid NOT NULL,
    storage_path text NOT NULL,
    visibility text DEFAULT 'parties'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT settlement_proofs_path_present CHECK ((btrim(storage_path) <> ''::text)),
    CONSTRAINT settlement_proofs_visibility_check CHECK ((visibility = 'parties'::text))
);


--
-- Name: settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    from_member_id uuid NOT NULL,
    to_member_id uuid NOT NULL,
    currency character(3) NOT NULL,
    amount bigint NOT NULL,
    method public."SettlementMethod" NOT NULL,
    status public."SettlementStatus" DEFAULT 'initiated'::public."SettlementStatus" NOT NULL,
    note text,
    initiated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    confirmed_at timestamp(6) with time zone,
    client_mutation_id uuid,
    updated_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    rail text,
    CONSTRAINT settlements_amount_positive CHECK ((amount > 0)),
    CONSTRAINT settlements_currency_upper CHECK (((currency)::text = upper((currency)::text))),
    CONSTRAINT settlements_distinct_members CHECK ((from_member_id <> to_member_id)),
    CONSTRAINT settlements_rail_known CHECK (((rail IS NULL) OR (rail = ANY (ARRAY['upi'::text, 'pix'::text, 'paynow'::text, 'promptpay'::text, 'qris'::text, 'aani'::text, 'payid'::text, 'zelle'::text, 'venmo'::text, 'cashapp'::text, 'interac'::text, 'wise'::text, 'revolut'::text, 'paypal'::text, 'bank'::text, 'cash'::text, 'other'::text]))))
);

ALTER TABLE ONLY public.settlements REPLICA IDENTITY FULL;


--
-- Name: storage_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_objects (
    logical_bucket text NOT NULL,
    path text NOT NULL,
    owner_profile_id uuid NOT NULL,
    group_id uuid,
    bytes bigint NOT NULL,
    content_type text DEFAULT 'image/webp'::text NOT NULL,
    counted boolean NOT NULL,
    pending boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_objects_bytes_check CHECK ((bytes >= 0))
);


--
-- Name: storage_orphans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_orphans (
    logical_bucket text NOT NULL,
    path text NOT NULL,
    enqueued_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    tier text DEFAULT 'plus'::text NOT NULL,
    period text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    current_period_end timestamp with time zone,
    store text NOT NULL,
    store_txn_id text,
    price_minor bigint,
    currency character(3),
    country_code character(2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_end_matches_period CHECK (((period = 'lifetime'::text) = (current_period_end IS NULL))),
    CONSTRAINT subscriptions_period_known CHECK ((period = ANY (ARRAY['monthly'::text, 'yearly'::text, 'lifetime'::text]))),
    CONSTRAINT subscriptions_status_known CHECK ((status = ANY (ARRAY['active'::text, 'grace'::text, 'expired'::text, 'cancelled'::text, 'refunded'::text]))),
    CONSTRAINT subscriptions_store_known CHECK ((store = ANY (ARRAY['play'::text, 'appstore'::text, 'promo'::text]))),
    CONSTRAINT subscriptions_tier_known CHECK ((tier = ANY (ARRAY['free'::text, 'plus'::text])))
);


--
-- Name: sync_mutations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_mutations (
    client_mutation_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    group_id uuid,
    kind text NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trip_member_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_member_budgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    member_id uuid NOT NULL,
    amount_minor bigint NOT NULL,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT trip_member_budgets_amount_sane CHECK ((amount_minor >= 0)),
    CONSTRAINT trip_member_budgets_visibility_valid CHECK ((visibility = ANY (ARRAY['private'::text, 'group'::text])))
);


--
-- Name: trip_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    expense_id uuid,
    day date,
    storage_path text NOT NULL,
    caption text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT trip_photos_caption_sane CHECK (((caption IS NULL) OR (char_length(caption) <= 500))),
    CONSTRAINT trip_photos_path_present CHECK ((btrim(storage_path) <> ''::text))
);


--
-- Name: trip_plan_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_plan_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    day date NOT NULL,
    starts_at time without time zone,
    title text NOT NULL,
    note text,
    category text,
    planned_minor bigint,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    done_at timestamp with time zone,
    expense_id uuid,
    "position" integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_seq bigint DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT trip_plan_items_planned_sane CHECK (((planned_minor IS NULL) OR (planned_minor >= 0))),
    CONSTRAINT trip_plan_items_title_present CHECK ((btrim(title) <> ''::text))
);


--
-- Name: usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    group_id uuid,
    kind text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cost_minor bigint DEFAULT 0 NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: voice_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid,
    transcript text NOT NULL,
    locale text,
    used_model boolean DEFAULT false NOT NULL,
    item_count integer DEFAULT 0 NOT NULL,
    platform text,
    app_version text,
    client_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_attempts_item_count_nonneg CHECK ((item_count >= 0)),
    CONSTRAINT voice_attempts_transcript_present CHECK (((length(TRIM(BOTH FROM transcript)) >= 1) AND (length(TRIM(BOTH FROM transcript)) <= 4000)))
);


--
-- Name: voice_stt_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_stt_usage (
    profile_id uuid NOT NULL,
    period text NOT NULL,
    seconds integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_stt_usage_seconds_nonneg CHECK ((seconds >= 0))
);


--
-- Name: activity_log activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: app_releases app_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_releases
    ADD CONSTRAINT app_releases_pkey PRIMARY KEY (platform);


--
-- Name: campaign_email_sends campaign_email_sends_once; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_email_sends
    ADD CONSTRAINT campaign_email_sends_once UNIQUE (campaign_id, profile_id);


--
-- Name: campaign_email_sends campaign_email_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_email_sends
    ADD CONSTRAINT campaign_email_sends_pkey PRIMARY KEY (id);


--
-- Name: campaign_impressions campaign_impressions_once; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_impressions
    ADD CONSTRAINT campaign_impressions_once UNIQUE (campaign_id, profile_id);


--
-- Name: campaign_impressions campaign_impressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_impressions
    ADD CONSTRAINT campaign_impressions_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: captures captures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_pkey PRIMARY KEY (id);


--
-- Name: category_tags category_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_tags
    ADD CONSTRAINT category_tags_pkey PRIMARY KEY (id);


--
-- Name: country_settings country_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_settings
    ADD CONSTRAINT country_settings_pkey PRIMARY KEY (code);


--
-- Name: device_sessions device_sessions_one_per_device; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT device_sessions_one_per_device UNIQUE (profile_id, device_id);


--
-- Name: device_sessions device_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT device_sessions_pkey PRIMARY KEY (id);


--
-- Name: email_events email_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_pkey PRIMARY KEY (id);


--
-- Name: email_suppressions email_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_suppressions
    ADD CONSTRAINT email_suppressions_pkey PRIMARY KEY (address);


--
-- Name: expense_attachments expense_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_attachments
    ADD CONSTRAINT expense_attachments_pkey PRIMARY KEY (id);


--
-- Name: expense_comments expense_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_comments
    ADD CONSTRAINT expense_comments_pkey PRIMARY KEY (id);


--
-- Name: expense_disputes expense_disputes_expense_id_member_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_disputes
    ADD CONSTRAINT expense_disputes_expense_id_member_id_key UNIQUE (expense_id, member_id);


--
-- Name: expense_disputes expense_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_disputes
    ADD CONSTRAINT expense_disputes_pkey PRIMARY KEY (id);


--
-- Name: expense_image_events expense_image_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_image_events
    ADD CONSTRAINT expense_image_events_pkey PRIMARY KEY (id);


--
-- Name: expense_payers expense_payers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_payers
    ADD CONSTRAINT expense_payers_pkey PRIMARY KEY (id);


--
-- Name: expense_shares expense_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_shares
    ADD CONSTRAINT expense_shares_pkey PRIMARY KEY (id);


--
-- Name: expense_versions expense_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_versions
    ADD CONSTRAINT expense_versions_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (key);


--
-- Name: feedback feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);


--
-- Name: ghost_merges ghost_merges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ghost_merges
    ADD CONSTRAINT ghost_merges_pkey PRIMARY KEY (owner, member_id);


--
-- Name: group_balances group_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_balances
    ADD CONSTRAINT group_balances_pkey PRIMARY KEY (group_id, member_id, currency);


--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (id);


--
-- Name: group_passes group_passes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_passes
    ADD CONSTRAINT group_passes_pkey PRIMARY KEY (id);


--
-- Name: group_passes group_passes_store_txn_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_passes
    ADD CONSTRAINT group_passes_store_txn_id_key UNIQUE (store_txn_id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);


--
-- Name: member_claims member_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_claims
    ADD CONSTRAINT member_claims_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: pairwise_balances pairwise_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairwise_balances
    ADD CONSTRAINT pairwise_balances_pkey PRIMARY KEY (group_id, from_member_id, to_member_id, currency);


--
-- Name: personal_records personal_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_records
    ADD CONSTRAINT personal_records_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: promo_codes promo_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_pkey PRIMARY KEY (code);


--
-- Name: promo_redemptions promo_redemptions_once; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_once UNIQUE (code, profile_id);


--
-- Name: promo_redemptions promo_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_pkey PRIMARY KEY (id);


--
-- Name: push_tokens push_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_tokens
    ADD CONSTRAINT push_tokens_pkey PRIMARY KEY (id);


--
-- Name: rate_limit_hits rate_limit_hits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_hits
    ADD CONSTRAINT rate_limit_hits_pkey PRIMARY KEY (subject, bucket, window_start);


--
-- Name: rate_limit_rules rate_limit_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_rules
    ADD CONSTRAINT rate_limit_rules_pkey PRIMARY KEY (bucket);


--
-- Name: rate_limit_settings rate_limit_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_settings
    ADD CONSTRAINT rate_limit_settings_pkey PRIMARY KEY (id);


--
-- Name: receipt_item_claims receipt_item_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_item_claims
    ADD CONSTRAINT receipt_item_claims_pkey PRIMARY KEY (id);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);


--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);


--
-- Name: service_config service_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_config
    ADD CONSTRAINT service_config_pkey PRIMARY KEY (key);


--
-- Name: settlement_allocations settlement_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_allocations
    ADD CONSTRAINT settlement_allocations_pkey PRIMARY KEY (id);


--
-- Name: settlement_proofs settlement_proofs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_proofs
    ADD CONSTRAINT settlement_proofs_pkey PRIMARY KEY (id);


--
-- Name: settlements settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_pkey PRIMARY KEY (id);


--
-- Name: storage_objects storage_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_pkey PRIMARY KEY (logical_bucket, path);


--
-- Name: storage_orphans storage_orphans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_orphans
    ADD CONSTRAINT storage_orphans_pkey PRIMARY KEY (logical_bucket, path);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_store_txn_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_store_txn_id_key UNIQUE (store_txn_id);


--
-- Name: sync_mutations sync_mutations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_mutations
    ADD CONSTRAINT sync_mutations_pkey PRIMARY KEY (client_mutation_id);


--
-- Name: trip_member_budgets trip_member_budgets_member_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_member_budgets
    ADD CONSTRAINT trip_member_budgets_member_id_key UNIQUE (member_id);


--
-- Name: trip_member_budgets trip_member_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_member_budgets
    ADD CONSTRAINT trip_member_budgets_pkey PRIMARY KEY (id);


--
-- Name: trip_photos trip_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_photos
    ADD CONSTRAINT trip_photos_pkey PRIMARY KEY (id);


--
-- Name: trip_plan_items trip_plan_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_plan_items
    ADD CONSTRAINT trip_plan_items_pkey PRIMARY KEY (id);


--
-- Name: usage_events usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);


--
-- Name: voice_attempts voice_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_attempts
    ADD CONSTRAINT voice_attempts_pkey PRIMARY KEY (id);


--
-- Name: voice_stt_usage voice_stt_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_stt_usage
    ADD CONSTRAINT voice_stt_usage_pkey PRIMARY KEY (profile_id, period);


--
-- Name: activity_log_group_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_log_group_id_created_at_idx ON public.activity_log USING btree (group_id, created_at);


--
-- Name: activity_log_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_log_group_id_updated_seq_idx ON public.activity_log USING btree (group_id, updated_seq);


--
-- Name: campaign_email_sends_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_email_sends_campaign_idx ON public.campaign_email_sends USING btree (campaign_id, status);


--
-- Name: campaign_impressions_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_impressions_campaign_idx ON public.campaign_impressions USING btree (campaign_id, seen_at);


--
-- Name: campaigns_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaigns_window_idx ON public.campaigns USING btree (starts_at, ends_at);


--
-- Name: captures_owner_user_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_owner_user_id_updated_seq_idx ON public.captures USING btree (owner_user_id, updated_seq);


--
-- Name: category_tags_owner_builtin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX category_tags_owner_builtin_idx ON public.category_tags USING btree (owner_user_id, builtin_id) WHERE ((builtin_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: category_tags_owner_user_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX category_tags_owner_user_id_updated_seq_idx ON public.category_tags USING btree (owner_user_id, updated_seq);


--
-- Name: device_sessions_profile_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_sessions_profile_seen_idx ON public.device_sessions USING btree (profile_id, last_seen_at DESC);


--
-- Name: email_events_profile_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_events_profile_id_created_at_idx ON public.email_events USING btree (profile_id, created_at);


--
-- Name: email_events_resend_email_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_events_resend_email_id_idx ON public.email_events USING btree (resend_email_id);


--
-- Name: expense_attachments_expense_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_attachments_expense_idx ON public.expense_attachments USING btree (expense_id);


--
-- Name: expense_attachments_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_attachments_group_id_updated_seq_idx ON public.expense_attachments USING btree (group_id, updated_seq);


--
-- Name: expense_comments_expense_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_comments_expense_idx ON public.expense_comments USING btree (expense_id, created_at);


--
-- Name: expense_comments_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_comments_group_id_updated_seq_idx ON public.expense_comments USING btree (group_id, updated_seq);


--
-- Name: expense_disputes_expense_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_disputes_expense_id_status_idx ON public.expense_disputes USING btree (expense_id, status);


--
-- Name: expense_image_events_expense_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_image_events_expense_idx ON public.expense_image_events USING btree (expense_id, created_at);


--
-- Name: expense_image_events_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_image_events_group_id_updated_seq_idx ON public.expense_image_events USING btree (group_id, updated_seq);


--
-- Name: expense_payers_expense_version_id_member_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX expense_payers_expense_version_id_member_id_key ON public.expense_payers USING btree (expense_version_id, member_id);


--
-- Name: expense_shares_expense_version_id_member_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX expense_shares_expense_version_id_member_id_key ON public.expense_shares USING btree (expense_version_id, member_id);


--
-- Name: expense_versions_client_mutation_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX expense_versions_client_mutation_id_key ON public.expense_versions USING btree (client_mutation_id);


--
-- Name: expense_versions_expense_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_versions_expense_id_idx ON public.expense_versions USING btree (expense_id);


--
-- Name: expense_versions_expense_id_version_no_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX expense_versions_expense_id_version_no_key ON public.expense_versions USING btree (expense_id, version_no);


--
-- Name: expenses_current_version_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX expenses_current_version_id_key ON public.expenses USING btree (current_version_id);


--
-- Name: expenses_group_id_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_group_id_deleted_at_idx ON public.expenses USING btree (group_id, deleted_at);


--
-- Name: expenses_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_group_id_updated_seq_idx ON public.expenses USING btree (group_id, updated_seq);


--
-- Name: feedback_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_recent_idx ON public.feedback USING btree (created_at DESC);


--
-- Name: ghost_merges_owner_person_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ghost_merges_owner_person_id_idx ON public.ghost_merges USING btree (owner, person_id);


--
-- Name: ghost_merges_owner_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ghost_merges_owner_updated_seq_idx ON public.ghost_merges USING btree (owner, updated_seq);


--
-- Name: group_members_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_members_group_id_idx ON public.group_members USING btree (group_id);


--
-- Name: group_members_group_id_profile_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX group_members_group_id_profile_id_key ON public.group_members USING btree (group_id, profile_id);


--
-- Name: group_members_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_members_group_id_updated_seq_idx ON public.group_members USING btree (group_id, updated_seq);


--
-- Name: group_passes_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_passes_group_idx ON public.group_passes USING btree (group_id, expires_at);


--
-- Name: groups_archived_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX groups_archived_at_idx ON public.groups USING btree (archived_at);


--
-- Name: groups_reminder_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX groups_reminder_window_idx ON public.groups USING btree (start_date, end_date);


--
-- Name: invites_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invites_group_id_idx ON public.invites USING btree (group_id);


--
-- Name: invites_token_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invites_token_hash_key ON public.invites USING btree (token_hash);


--
-- Name: member_claims_group_id_status_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_claims_group_id_status_created_at_idx ON public.member_claims USING btree (group_id, status, created_at);


--
-- Name: member_claims_requester_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_claims_requester_id_created_at_idx ON public.member_claims USING btree (requester_id, created_at);


--
-- Name: notifications_dedupe_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notifications_dedupe_key_key ON public.notifications USING btree (dedupe_key);


--
-- Name: notifications_profile_id_read_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_profile_id_read_at_idx ON public.notifications USING btree (profile_id, read_at);


--
-- Name: personal_records_owner_user_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_records_owner_user_id_updated_seq_idx ON public.personal_records USING btree (owner_user_id, updated_seq);


--
-- Name: promo_redemptions_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promo_redemptions_profile_idx ON public.promo_redemptions USING btree (profile_id, redeemed_at);


--
-- Name: push_tokens_expo_push_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX push_tokens_expo_push_token_key ON public.push_tokens USING btree (expo_push_token);


--
-- Name: push_tokens_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_tokens_profile_id_idx ON public.push_tokens USING btree (profile_id);


--
-- Name: rate_limit_hits_window_start_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rate_limit_hits_window_start_idx ON public.rate_limit_hits USING btree (window_start);


--
-- Name: receipt_item_claims_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receipt_item_claims_live_idx ON public.receipt_item_claims USING btree (receipt_id, item_index) WHERE (released_at IS NULL);


--
-- Name: receipt_item_claims_receipt_id_item_index_member_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX receipt_item_claims_receipt_id_item_index_member_id_key ON public.receipt_item_claims USING btree (receipt_id, item_index, member_id);


--
-- Name: receipts_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receipts_group_id_idx ON public.receipts USING btree (group_id);


--
-- Name: reminders_group_id_from_member_id_to_member_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX reminders_group_id_from_member_id_to_member_id_key ON public.reminders USING btree (group_id, from_member_id, to_member_id);


--
-- Name: settlement_allocations_settlement_id_expense_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX settlement_allocations_settlement_id_expense_id_key ON public.settlement_allocations USING btree (settlement_id, expense_id);


--
-- Name: settlement_proofs_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlement_proofs_group_id_updated_seq_idx ON public.settlement_proofs USING btree (group_id, updated_seq);


--
-- Name: settlement_proofs_settlement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlement_proofs_settlement_idx ON public.settlement_proofs USING btree (settlement_id);


--
-- Name: settlements_client_mutation_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX settlements_client_mutation_id_key ON public.settlements USING btree (client_mutation_id);


--
-- Name: settlements_group_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlements_group_id_status_idx ON public.settlements USING btree (group_id, status);


--
-- Name: settlements_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlements_group_id_updated_seq_idx ON public.settlements USING btree (group_id, updated_seq);


--
-- Name: storage_objects_owner_counted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_objects_owner_counted_idx ON public.storage_objects USING btree (owner_profile_id, counted);


--
-- Name: subscriptions_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_profile_idx ON public.subscriptions USING btree (profile_id, status);


--
-- Name: sync_mutations_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sync_mutations_profile_idx ON public.sync_mutations USING btree (profile_id, applied_at DESC);


--
-- Name: trip_member_budgets_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_member_budgets_group_id_idx ON public.trip_member_budgets USING btree (group_id);


--
-- Name: trip_member_budgets_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_member_budgets_group_id_updated_seq_idx ON public.trip_member_budgets USING btree (group_id, updated_seq);


--
-- Name: trip_photos_expense_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_photos_expense_idx ON public.trip_photos USING btree (expense_id);


--
-- Name: trip_photos_group_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_photos_group_day_idx ON public.trip_photos USING btree (group_id, day);


--
-- Name: trip_photos_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_photos_group_id_updated_seq_idx ON public.trip_photos USING btree (group_id, updated_seq);


--
-- Name: trip_plan_items_group_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_plan_items_group_day_idx ON public.trip_plan_items USING btree (group_id, day, "position");


--
-- Name: trip_plan_items_group_id_updated_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_plan_items_group_id_updated_seq_idx ON public.trip_plan_items USING btree (group_id, updated_seq);


--
-- Name: usage_events_profile_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_events_profile_id_created_at_idx ON public.usage_events USING btree (profile_id, created_at);


--
-- Name: voice_attempts_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_attempts_recent_idx ON public.voice_attempts USING btree (created_at DESC);


--
-- Name: activity_log activity_log_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER activity_log_append_only BEFORE DELETE OR UPDATE ON public.activity_log FOR EACH ROW EXECUTE FUNCTION public.waves_forbid_mutation();


--
-- Name: activity_log activity_log_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER activity_log_stamp_seq BEFORE INSERT ON public.activity_log FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: captures captures_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER captures_stamp_seq BEFORE INSERT OR UPDATE ON public.captures FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_capture_seq();


--
-- Name: category_tags category_tags_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER category_tags_stamp_seq BEFORE INSERT OR UPDATE ON public.category_tags FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_category_tag_seq();


--
-- Name: expense_attachments expense_attachments_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_attachments_stamp_seq BEFORE INSERT OR UPDATE ON public.expense_attachments FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: expense_comments expense_comments_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_comments_stamp_seq BEFORE INSERT OR UPDATE ON public.expense_comments FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: expense_image_events expense_image_events_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_image_events_stamp_seq BEFORE INSERT OR UPDATE ON public.expense_image_events FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: expense_payers expense_payers_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_payers_append_only BEFORE UPDATE ON public.expense_payers FOR EACH ROW EXECUTE FUNCTION public.waves_forbid_mutation();


--
-- Name: expense_payers expense_payers_refresh_balances; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER expense_payers_refresh_balances AFTER INSERT OR DELETE ON public.expense_payers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.waves_touch_balances();


--
-- Name: expense_payers expense_payers_totals_match; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER expense_payers_totals_match AFTER INSERT OR DELETE ON public.expense_payers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.waves_check_expense_totals();


--
-- Name: expense_shares expense_shares_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_shares_append_only BEFORE UPDATE ON public.expense_shares FOR EACH ROW EXECUTE FUNCTION public.waves_forbid_mutation();


--
-- Name: expense_shares expense_shares_refresh_balances; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER expense_shares_refresh_balances AFTER INSERT OR DELETE ON public.expense_shares DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.waves_touch_balances();


--
-- Name: expense_shares expense_shares_totals_match; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER expense_shares_totals_match AFTER INSERT OR DELETE ON public.expense_shares DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.waves_check_expense_totals();


--
-- Name: expense_versions expense_versions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_versions_append_only BEFORE DELETE OR UPDATE ON public.expense_versions FOR EACH ROW EXECUTE FUNCTION public.waves_forbid_mutation();


--
-- Name: expense_versions expense_versions_close_disputes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_versions_close_disputes AFTER INSERT ON public.expense_versions FOR EACH ROW WHEN ((new.version_no > 1)) EXECUTE FUNCTION public.waves_close_disputes_on_new_version();


--
-- Name: expense_versions expense_versions_totals_match; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER expense_versions_totals_match AFTER INSERT ON public.expense_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.waves_check_expense_totals();


--
-- Name: expenses expenses_no_hard_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expenses_no_hard_delete BEFORE DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.waves_forbid_mutation();


--
-- Name: expenses expenses_refresh_balances; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER expenses_refresh_balances AFTER INSERT OR UPDATE ON public.expenses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.waves_touch_balances();


--
-- Name: expenses expenses_restore_window; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expenses_restore_window BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.waves_expense_restore_window();


--
-- Name: expenses expenses_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expenses_stamp_seq BEFORE INSERT OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: ghost_merges ghost_merges_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ghost_merges_stamp_seq BEFORE INSERT OR UPDATE ON public.ghost_merges FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_ghost_merge_seq();


--
-- Name: group_members group_members_guard_columns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER group_members_guard_columns BEFORE UPDATE ON public.group_members FOR EACH ROW EXECUTE FUNCTION public.waves_guard_membership_columns();


--
-- Name: group_members group_members_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER group_members_stamp_seq BEFORE INSERT OR UPDATE ON public.group_members FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: groups groups_guard_columns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER groups_guard_columns BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.waves_guard_group_columns();


--
-- Name: groups groups_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER groups_stamp_seq BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_group_seq();


--
-- Name: personal_records personal_records_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER personal_records_stamp_seq BEFORE INSERT OR UPDATE ON public.personal_records FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_personal_seq();


--
-- Name: reminders reminders_nudge_rate_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reminders_nudge_rate_limit BEFORE UPDATE ON public.reminders FOR EACH ROW EXECUTE FUNCTION public.waves_nudge_rate_limit();


--
-- Name: settlement_allocations settlement_allocations_within_settlement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER settlement_allocations_within_settlement AFTER INSERT OR DELETE OR UPDATE ON public.settlement_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.waves_check_settlement_allocations();


--
-- Name: settlement_proofs settlement_proofs_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlement_proofs_stamp_seq BEFORE INSERT OR UPDATE ON public.settlement_proofs FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: settlements settlements_no_hard_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_no_hard_delete BEFORE DELETE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.waves_forbid_mutation();


--
-- Name: settlements settlements_refresh_balances; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER settlements_refresh_balances AFTER INSERT OR UPDATE ON public.settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.waves_touch_balances();


--
-- Name: settlements settlements_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_stamp_seq BEFORE INSERT OR UPDATE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: settlements settlements_transition_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_transition_guard BEFORE UPDATE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.waves_settlement_transition();


--
-- Name: storage_objects storage_objects_enqueue_orphan; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER storage_objects_enqueue_orphan BEFORE DELETE ON public.storage_objects FOR EACH ROW EXECUTE FUNCTION public.waves_storage_enqueue_orphan();


--
-- Name: trip_member_budgets trip_member_budgets_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trip_member_budgets_stamp_seq BEFORE INSERT OR UPDATE ON public.trip_member_budgets FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: trip_photos trip_photos_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trip_photos_stamp_seq BEFORE INSERT OR UPDATE ON public.trip_photos FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: trip_plan_items trip_plan_items_stamp_seq; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trip_plan_items_stamp_seq BEFORE INSERT OR UPDATE ON public.trip_plan_items FOR EACH ROW EXECUTE FUNCTION public.waves_stamp_seq();


--
-- Name: notifications waves_notify_fanout_on_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER waves_notify_fanout_on_insert AFTER INSERT ON public.notifications FOR EACH STATEMENT EXECUTE FUNCTION public.waves_notify_fanout_trigger();


--
-- Name: activity_log activity_log_actor_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_actor_member_id_fkey FOREIGN KEY (actor_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: activity_log activity_log_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: campaign_email_sends campaign_email_sends_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_email_sends
    ADD CONSTRAINT campaign_email_sends_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: campaign_email_sends campaign_email_sends_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_email_sends
    ADD CONSTRAINT campaign_email_sends_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: campaign_impressions campaign_impressions_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_impressions
    ADD CONSTRAINT campaign_impressions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: campaign_impressions campaign_impressions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_impressions
    ADD CONSTRAINT campaign_impressions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: campaigns campaigns_promo_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_promo_code_fkey FOREIGN KEY (promo_code) REFERENCES public.promo_codes(code) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: captures captures_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: category_tags category_tags_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_tags
    ADD CONSTRAINT category_tags_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: device_sessions device_sessions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT device_sessions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: email_events email_events_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: email_events email_events_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_attachments expense_attachments_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_attachments
    ADD CONSTRAINT expense_attachments_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_attachments expense_attachments_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_attachments
    ADD CONSTRAINT expense_attachments_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_attachments expense_attachments_uploader_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_attachments
    ADD CONSTRAINT expense_attachments_uploader_member_id_fkey FOREIGN KEY (uploader_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_comments expense_comments_author_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_comments
    ADD CONSTRAINT expense_comments_author_member_id_fkey FOREIGN KEY (author_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expense_comments expense_comments_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_comments
    ADD CONSTRAINT expense_comments_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expense_comments expense_comments_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_comments
    ADD CONSTRAINT expense_comments_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_comments expense_comments_flagged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_comments
    ADD CONSTRAINT expense_comments_flagged_by_fkey FOREIGN KEY (flagged_by) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expense_comments expense_comments_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_comments
    ADD CONSTRAINT expense_comments_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_disputes expense_disputes_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_disputes
    ADD CONSTRAINT expense_disputes_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_disputes expense_disputes_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_disputes
    ADD CONSTRAINT expense_disputes_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_disputes expense_disputes_resolved_by_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_disputes
    ADD CONSTRAINT expense_disputes_resolved_by_member_id_fkey FOREIGN KEY (resolved_by_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expense_image_events expense_image_events_actor_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_image_events
    ADD CONSTRAINT expense_image_events_actor_member_id_fkey FOREIGN KEY (actor_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expense_image_events expense_image_events_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_image_events
    ADD CONSTRAINT expense_image_events_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_image_events expense_image_events_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_image_events
    ADD CONSTRAINT expense_image_events_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_payers expense_payers_expense_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_payers
    ADD CONSTRAINT expense_payers_expense_version_id_fkey FOREIGN KEY (expense_version_id) REFERENCES public.expense_versions(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_payers expense_payers_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_payers
    ADD CONSTRAINT expense_payers_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_shares expense_shares_expense_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_shares
    ADD CONSTRAINT expense_shares_expense_version_id_fkey FOREIGN KEY (expense_version_id) REFERENCES public.expense_versions(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_shares expense_shares_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_shares
    ADD CONSTRAINT expense_shares_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_versions expense_versions_author_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_versions
    ADD CONSTRAINT expense_versions_author_member_id_fkey FOREIGN KEY (author_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expense_versions expense_versions_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_versions
    ADD CONSTRAINT expense_versions_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: expense_versions expense_versions_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_versions
    ADD CONSTRAINT expense_versions_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.receipts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expenses expenses_current_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES public.expense_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expenses expenses_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: expenses expenses_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: feedback feedback_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: ghost_merges ghost_merges_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ghost_merges
    ADD CONSTRAINT ghost_merges_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ghost_merges ghost_merges_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ghost_merges
    ADD CONSTRAINT ghost_merges_owner_fkey FOREIGN KEY (owner) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: group_balances group_balances_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_balances
    ADD CONSTRAINT group_balances_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: group_balances group_balances_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_balances
    ADD CONSTRAINT group_balances_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: group_members group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: group_members group_members_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: group_passes group_passes_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_passes
    ADD CONSTRAINT group_passes_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: group_passes group_passes_purchased_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_passes
    ADD CONSTRAINT group_passes_purchased_by_fkey FOREIGN KEY (purchased_by) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: invites invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: invites invites_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: member_claims member_claims_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_claims
    ADD CONSTRAINT member_claims_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: member_claims member_claims_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_claims
    ADD CONSTRAINT member_claims_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: member_claims member_claims_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_claims
    ADD CONSTRAINT member_claims_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: member_claims member_claims_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_claims
    ADD CONSTRAINT member_claims_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: notifications notifications_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: notifications notifications_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: pairwise_balances pairwise_balances_from_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairwise_balances
    ADD CONSTRAINT pairwise_balances_from_member_id_fkey FOREIGN KEY (from_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: pairwise_balances pairwise_balances_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairwise_balances
    ADD CONSTRAINT pairwise_balances_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: pairwise_balances pairwise_balances_to_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairwise_balances
    ADD CONSTRAINT pairwise_balances_to_member_id_fkey FOREIGN KEY (to_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: personal_records personal_records_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_records
    ADD CONSTRAINT personal_records_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: promo_redemptions promo_redemptions_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_code_fkey FOREIGN KEY (code) REFERENCES public.promo_codes(code) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: promo_redemptions promo_redemptions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: promo_redemptions promo_redemptions_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: push_tokens push_tokens_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_tokens
    ADD CONSTRAINT push_tokens_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: receipt_item_claims receipt_item_claims_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_item_claims
    ADD CONSTRAINT receipt_item_claims_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: receipt_item_claims receipt_item_claims_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_item_claims
    ADD CONSTRAINT receipt_item_claims_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.receipts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: receipts receipts_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: reminders reminders_from_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_from_member_id_fkey FOREIGN KEY (from_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: reminders reminders_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: reminders reminders_to_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_to_member_id_fkey FOREIGN KEY (to_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settlement_allocations settlement_allocations_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_allocations
    ADD CONSTRAINT settlement_allocations_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settlement_allocations settlement_allocations_settlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_allocations
    ADD CONSTRAINT settlement_allocations_settlement_id_fkey FOREIGN KEY (settlement_id) REFERENCES public.settlements(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settlement_proofs settlement_proofs_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_proofs
    ADD CONSTRAINT settlement_proofs_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settlement_proofs settlement_proofs_settlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_proofs
    ADD CONSTRAINT settlement_proofs_settlement_id_fkey FOREIGN KEY (settlement_id) REFERENCES public.settlements(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settlement_proofs settlement_proofs_uploader_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_proofs
    ADD CONSTRAINT settlement_proofs_uploader_member_id_fkey FOREIGN KEY (uploader_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settlements settlements_from_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_from_member_id_fkey FOREIGN KEY (from_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settlements settlements_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settlements settlements_to_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_to_member_id_fkey FOREIGN KEY (to_member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: storage_objects storage_objects_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: storage_objects storage_objects_owner_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_owner_profile_id_fkey FOREIGN KEY (owner_profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: sync_mutations sync_mutations_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_mutations
    ADD CONSTRAINT sync_mutations_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: sync_mutations sync_mutations_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_mutations
    ADD CONSTRAINT sync_mutations_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip_member_budgets trip_member_budgets_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_member_budgets
    ADD CONSTRAINT trip_member_budgets_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip_member_budgets trip_member_budgets_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_member_budgets
    ADD CONSTRAINT trip_member_budgets_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip_photos trip_photos_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_photos
    ADD CONSTRAINT trip_photos_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: trip_photos trip_photos_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_photos
    ADD CONSTRAINT trip_photos_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: trip_photos trip_photos_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_photos
    ADD CONSTRAINT trip_photos_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip_plan_items trip_plan_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_plan_items
    ADD CONSTRAINT trip_plan_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.group_members(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: trip_plan_items trip_plan_items_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_plan_items
    ADD CONSTRAINT trip_plan_items_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: trip_plan_items trip_plan_items_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_plan_items
    ADD CONSTRAINT trip_plan_items_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: usage_events usage_events_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: usage_events usage_events_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: voice_attempts voice_attempts_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_attempts
    ADD CONSTRAINT voice_attempts_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: voice_stt_usage voice_stt_usage_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_stt_usage
    ADD CONSTRAINT voice_stt_usage_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: activity_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

--
-- Name: activity_log activity_log_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activity_log_select ON public.activity_log FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: app_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

--
-- Name: app_config app_config_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_config_read ON public.app_config FOR SELECT TO anon, authenticated USING (true);


--
-- Name: app_releases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_releases ENABLE ROW LEVEL SECURITY;

--
-- Name: app_releases app_releases are readable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "app_releases are readable by everyone" ON public.app_releases FOR SELECT TO anon, authenticated USING (true);


--
-- Name: campaign_email_sends; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_email_sends ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_impressions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_impressions ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_impressions campaign_impressions_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY campaign_impressions_own ON public.campaign_impressions FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: captures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.captures ENABLE ROW LEVEL SECURITY;

--
-- Name: captures captures_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY captures_own ON public.captures TO authenticated USING ((owner_user_id = public.waves_current_profile_id())) WITH CHECK ((owner_user_id = public.waves_current_profile_id()));


--
-- Name: category_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.category_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: category_tags category_tags_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY category_tags_own ON public.category_tags TO authenticated USING ((owner_user_id = public.waves_current_profile_id())) WITH CHECK ((owner_user_id = public.waves_current_profile_id()));


--
-- Name: country_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.country_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: country_settings country_settings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY country_settings_read ON public.country_settings FOR SELECT TO anon, authenticated USING (true);


--
-- Name: device_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: device_sessions device_sessions_own_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY device_sessions_own_read ON public.device_sessions FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: email_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;

--
-- Name: email_events email_events_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY email_events_select_own ON public.email_events FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: email_suppressions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_attachments expense_attachments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expense_attachments_select ON public.expense_attachments FOR SELECT TO anon, authenticated USING ((public.is_group_member(group_id) AND ((visibility = 'group'::text) OR public.waves_is_expense_party(expense_id))));


--
-- Name: expense_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_comments expense_comments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expense_comments_select ON public.expense_comments FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: expense_disputes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_disputes ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_disputes expense_disputes_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expense_disputes_select ON public.expense_disputes FOR SELECT TO anon, authenticated USING (public.is_group_member(( SELECT expenses.group_id
   FROM public.expenses
  WHERE (expenses.id = expense_disputes.expense_id))));


--
-- Name: expense_image_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_image_events ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_image_events expense_image_events_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expense_image_events_select ON public.expense_image_events FOR SELECT TO anon, authenticated USING ((public.is_group_member(group_id) AND ((visibility = 'group'::text) OR public.waves_is_expense_party(expense_id))));


--
-- Name: expense_payers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_payers ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_payers expense_payers_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expense_payers_select ON public.expense_payers FOR SELECT TO anon, authenticated USING (public.is_group_member(public.waves_version_group_id(expense_version_id)));


--
-- Name: expense_shares; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_shares expense_shares_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expense_shares_select ON public.expense_shares FOR SELECT TO anon, authenticated USING (public.is_group_member(public.waves_version_group_id(expense_version_id)));


--
-- Name: expense_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_versions expense_versions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expense_versions_select ON public.expense_versions FOR SELECT TO anon, authenticated USING (public.is_group_member(public.waves_version_group_id(id)));


--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses expenses_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expenses_select ON public.expenses FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags feature_flags_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feature_flags_read ON public.feature_flags FOR SELECT TO anon, authenticated USING (true);


--
-- Name: feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: feedback feedback_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_own ON public.feedback FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: ghost_merges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ghost_merges ENABLE ROW LEVEL SECURITY;

--
-- Name: ghost_merges ghost_merges_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ghost_merges_delete_own ON public.ghost_merges FOR DELETE TO anon, authenticated USING ((owner = public.waves_current_profile_id()));


--
-- Name: ghost_merges ghost_merges_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ghost_merges_insert_own ON public.ghost_merges FOR INSERT TO anon, authenticated WITH CHECK ((owner = public.waves_current_profile_id()));


--
-- Name: ghost_merges ghost_merges_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ghost_merges_select_own ON public.ghost_merges FOR SELECT TO anon, authenticated USING ((owner = public.waves_current_profile_id()));


--
-- Name: ghost_merges ghost_merges_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ghost_merges_update_own ON public.ghost_merges FOR UPDATE TO anon, authenticated USING ((owner = public.waves_current_profile_id())) WITH CHECK ((owner = public.waves_current_profile_id()));


--
-- Name: group_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: group_balances group_balances_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_balances_select ON public.group_balances FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: group_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

--
-- Name: group_members group_members_insert_ghost; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_members_insert_ghost ON public.group_members FOR INSERT TO anon, authenticated WITH CHECK ((public.is_group_member(group_id) AND (profile_id IS NULL)));


--
-- Name: group_members group_members_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_members_select ON public.group_members FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: group_members group_members_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_members_update ON public.group_members FOR UPDATE TO anon, authenticated USING ((public.is_group_member(group_id) AND (profile_id IS NULL))) WITH CHECK ((public.is_group_member(group_id) AND (profile_id IS NULL)));


--
-- Name: group_members group_members_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_members_update_self ON public.group_members FOR UPDATE TO authenticated USING ((profile_id = public.waves_current_profile_id())) WITH CHECK ((profile_id = public.waves_current_profile_id()));


--
-- Name: group_passes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_passes ENABLE ROW LEVEL SECURITY;

--
-- Name: group_passes group_passes_select_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_passes_select_members ON public.group_passes FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

--
-- Name: groups groups_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY groups_insert ON public.groups FOR INSERT TO authenticated WITH CHECK ((created_by = public.waves_current_profile_id()));


--
-- Name: groups groups_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY groups_select ON public.groups FOR SELECT TO anon, authenticated USING (public.is_group_member(id));


--
-- Name: groups groups_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY groups_update ON public.groups FOR UPDATE TO anon, authenticated USING (public.is_group_member(id)) WITH CHECK (public.is_group_member(id));


--
-- Name: invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

--
-- Name: invites invites_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invites_insert ON public.invites FOR INSERT TO authenticated WITH CHECK (public.is_group_member(group_id));


--
-- Name: invites invites_revoke; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invites_revoke ON public.invites FOR UPDATE TO authenticated USING (public.is_group_admin(group_id)) WITH CHECK (public.is_group_admin(group_id));


--
-- Name: member_claims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.member_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: member_claims member_claims_visible; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY member_claims_visible ON public.member_claims FOR SELECT TO authenticated USING (((requester_id = public.waves_current_profile_id()) OR (EXISTS ( SELECT 1
   FROM public.group_members gm
  WHERE ((gm.group_id = member_claims.group_id) AND (gm.profile_id = public.waves_current_profile_id()) AND (gm.role = 'admin'::public."MemberRole") AND (gm.left_at IS NULL))))));


--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_select_own ON public.notifications FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: notifications notifications_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_update_own ON public.notifications FOR UPDATE TO authenticated USING ((profile_id = public.waves_current_profile_id())) WITH CHECK ((profile_id = public.waves_current_profile_id()));


--
-- Name: pairwise_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pairwise_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: pairwise_balances pairwise_balances_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pairwise_balances_select ON public.pairwise_balances FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: personal_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.personal_records ENABLE ROW LEVEL SECURITY;

--
-- Name: personal_records personal_records_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY personal_records_own ON public.personal_records TO authenticated USING ((owner_user_id = public.waves_current_profile_id())) WITH CHECK ((owner_user_id = public.waves_current_profile_id()));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_insert_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_insert_self ON public.profiles FOR INSERT TO anon, authenticated WITH CHECK ((id = public.waves_current_profile_id()));


--
-- Name: profiles profiles_select_co_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_co_members ON public.profiles FOR SELECT TO anon, authenticated USING ((EXISTS ( SELECT 1
   FROM (public.group_members mine
     JOIN public.group_members theirs ON ((theirs.group_id = mine.group_id)))
  WHERE ((mine.profile_id = public.waves_current_profile_id()) AND (mine.left_at IS NULL) AND (theirs.profile_id = profiles.id)))));


--
-- Name: profiles profiles_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_self ON public.profiles FOR SELECT TO anon, authenticated USING ((id = public.waves_current_profile_id()));


--
-- Name: profiles profiles_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE TO anon, authenticated USING ((id = public.waves_current_profile_id())) WITH CHECK ((id = public.waves_current_profile_id()));


--
-- Name: promo_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_redemptions promo_redemptions_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY promo_redemptions_own ON public.promo_redemptions FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: push_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: push_tokens push_tokens_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_tokens_own ON public.push_tokens TO authenticated USING ((profile_id = public.waves_current_profile_id())) WITH CHECK ((profile_id = public.waves_current_profile_id()));


--
-- Name: rate_limit_hits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_limit_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_limit_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_limit_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_limit_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: receipt_item_claims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.receipt_item_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: receipt_item_claims receipt_item_claims_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY receipt_item_claims_select ON public.receipt_item_claims FOR SELECT TO anon, authenticated USING (public.is_group_member(( SELECT receipts.group_id
   FROM public.receipts
  WHERE (receipts.id = receipt_item_claims.receipt_id))));


--
-- Name: receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: receipts receipts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY receipts_select ON public.receipts FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: reminders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

--
-- Name: reminders reminders_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reminders_insert ON public.reminders FOR INSERT TO anon, authenticated WITH CHECK (public.is_group_member(group_id));


--
-- Name: reminders reminders_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reminders_select ON public.reminders FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: reminders reminders_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reminders_update ON public.reminders FOR UPDATE TO anon, authenticated USING (public.is_group_member(group_id)) WITH CHECK (public.is_group_member(group_id));


--
-- Name: service_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_config ENABLE ROW LEVEL SECURITY;

--
-- Name: service_config service_config_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_config_select ON public.service_config FOR SELECT TO authenticated USING (true);


--
-- Name: settlement_allocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlement_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_allocations settlement_allocations_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settlement_allocations_select ON public.settlement_allocations FOR SELECT TO anon, authenticated USING (public.is_group_member(( SELECT settlements.group_id
   FROM public.settlements
  WHERE (settlements.id = settlement_allocations.settlement_id))));


--
-- Name: settlement_proofs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlement_proofs ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_proofs settlement_proofs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settlement_proofs_select ON public.settlement_proofs FOR SELECT TO anon, authenticated USING ((public.is_group_member(group_id) AND public.waves_is_settlement_party(settlement_id)));


--
-- Name: settlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;

--
-- Name: settlements settlements_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settlements_select ON public.settlements FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: storage_objects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_objects ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_orphans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_orphans ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions subscriptions_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscriptions_select_own ON public.subscriptions FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: sync_mutations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_mutations ENABLE ROW LEVEL SECURITY;

--
-- Name: trip_member_budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trip_member_budgets ENABLE ROW LEVEL SECURITY;

--
-- Name: trip_member_budgets trip_member_budgets_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_member_budgets_select ON public.trip_member_budgets FOR SELECT TO anon, authenticated USING ((public.is_group_member(group_id) AND ((visibility = 'group'::text) OR (member_id = public.waves_my_member_id(group_id)))));


--
-- Name: trip_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trip_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: trip_photos trip_photos_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_photos_select ON public.trip_photos FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: trip_plan_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trip_plan_items ENABLE ROW LEVEL SECURITY;

--
-- Name: trip_plan_items trip_plan_items_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_plan_items_select ON public.trip_plan_items FOR SELECT TO anon, authenticated USING (public.is_group_member(group_id));


--
-- Name: usage_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_events usage_events_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_events_select_own ON public.usage_events FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: voice_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_attempts voice_attempts_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY voice_attempts_insert_own ON public.voice_attempts FOR INSERT TO authenticated WITH CHECK ((profile_id = public.waves_current_profile_id()));


--
-- Name: voice_stt_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_stt_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_stt_usage voice_stt_usage_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY voice_stt_usage_select_own ON public.voice_stt_usage FOR SELECT TO authenticated USING ((profile_id = public.waves_current_profile_id()));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION is_group_admin(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_group_admin(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_group_admin(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_group_admin(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_add_expense_comment(p_group_id uuid, p_expense_id uuid, p_comment_id uuid, p_body text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_add_expense_comment(p_group_id uuid, p_expense_id uuid, p_comment_id uuid, p_body text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_add_expense_comment(p_group_id uuid, p_expense_id uuid, p_comment_id uuid, p_body text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_add_expense_comment(p_group_id uuid, p_expense_id uuid, p_comment_id uuid, p_body text) TO service_role;


--
-- Name: FUNCTION waves_add_ghost_member(p_group_id uuid, p_name text, p_member_id uuid, p_email text, p_phone text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_add_ghost_member(p_group_id uuid, p_name text, p_member_id uuid, p_email text, p_phone text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_add_ghost_member(p_group_id uuid, p_name text, p_member_id uuid, p_email text, p_phone text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_add_ghost_member(p_group_id uuid, p_name text, p_member_id uuid, p_email text, p_phone text) TO service_role;


--
-- Name: FUNCTION waves_add_plan_item(p_group_id uuid, p_day date, p_title text, p_starts_at time without time zone, p_note text, p_category text, p_planned_minor bigint, p_currency character, p_item_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_add_plan_item(p_group_id uuid, p_day date, p_title text, p_starts_at time without time zone, p_note text, p_category text, p_planned_minor bigint, p_currency character, p_item_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_add_plan_item(p_group_id uuid, p_day date, p_title text, p_starts_at time without time zone, p_note text, p_category text, p_planned_minor bigint, p_currency character, p_item_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_add_plan_item(p_group_id uuid, p_day date, p_title text, p_starts_at time without time zone, p_note text, p_category text, p_planned_minor bigint, p_currency character, p_item_id uuid) TO service_role;


--
-- Name: FUNCTION waves_add_trip_photo(p_group_id uuid, p_storage_path text, p_photo_id uuid, p_expense_id uuid, p_day date, p_caption text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_add_trip_photo(p_group_id uuid, p_storage_path text, p_photo_id uuid, p_expense_id uuid, p_day date, p_caption text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_add_trip_photo(p_group_id uuid, p_storage_path text, p_photo_id uuid, p_expense_id uuid, p_day date, p_caption text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_add_trip_photo(p_group_id uuid, p_storage_path text, p_photo_id uuid, p_expense_id uuid, p_day date, p_caption text) TO service_role;


--
-- Name: FUNCTION waves_admin_ai_cost(p_days integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_ai_cost(p_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_ai_cost(p_days integer) TO service_role;


--
-- Name: FUNCTION waves_admin_campaign_email_stats(p_campaign_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_campaign_email_stats(p_campaign_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_campaign_email_stats(p_campaign_id uuid) TO service_role;


--
-- Name: FUNCTION waves_admin_campaign_funnel(p_campaign_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_campaign_funnel(p_campaign_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_campaign_funnel(p_campaign_id uuid) TO service_role;


--
-- Name: FUNCTION waves_admin_campaign_revenue(p_campaign_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_campaign_revenue(p_campaign_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_campaign_revenue(p_campaign_id uuid) TO service_role;


--
-- Name: FUNCTION waves_admin_daily(p_days integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_daily(p_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_daily(p_days integer) TO service_role;


--
-- Name: FUNCTION waves_admin_feedback(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_feedback(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_feedback(p_limit integer) TO service_role;


--
-- Name: FUNCTION waves_admin_flag_results(p_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_flag_results(p_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_flag_results(p_key text) TO service_role;


--
-- Name: FUNCTION waves_admin_geo(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_geo() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_geo() TO service_role;


--
-- Name: FUNCTION waves_admin_grant_promo(p_profile_id uuid, p_days integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_grant_promo(p_profile_id uuid, p_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_grant_promo(p_profile_id uuid, p_days integer) TO service_role;


--
-- Name: FUNCTION waves_admin_logins(p_days integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_logins(p_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_logins(p_days integer) TO service_role;


--
-- Name: FUNCTION waves_admin_money(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_money() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_money() TO service_role;


--
-- Name: FUNCTION waves_admin_overview(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_overview() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_overview() TO service_role;


--
-- Name: FUNCTION waves_admin_promo_codes(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_promo_codes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_promo_codes() TO service_role;


--
-- Name: FUNCTION waves_admin_users(p_limit integer, p_offset integer, p_name_prefix text, p_country text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_users(p_limit integer, p_offset integer, p_name_prefix text, p_country text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_users(p_limit integer, p_offset integer, p_name_prefix text, p_country text) TO service_role;


--
-- Name: FUNCTION waves_admin_voice_attempts(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_admin_voice_attempts(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_admin_voice_attempts(p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.waves_admin_voice_attempts(p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.waves_admin_voice_attempts(p_limit integer) TO service_role;


--
-- Name: FUNCTION waves_annotate_expense_attachment(p_attachment_id uuid, p_annotations jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_annotate_expense_attachment(p_attachment_id uuid, p_annotations jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_annotate_expense_attachment(p_attachment_id uuid, p_annotations jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.waves_annotate_expense_attachment(p_attachment_id uuid, p_annotations jsonb) TO service_role;


--
-- Name: FUNCTION waves_apply_expense(p_group_id uuid, p_expense_id uuid, p_author_member_id uuid, p_description text, p_category text, p_expense_date date, p_currency character, p_amount bigint, p_split_type text, p_split_params jsonb, p_payers jsonb, p_shares jsonb, p_client_mutation_id uuid, p_notes text, p_receipt_id uuid, p_base_version_no integer, p_fx jsonb, p_source text, p_payment_method text, p_receipt_share_url text, p_category_meta jsonb, p_location jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_apply_expense(p_group_id uuid, p_expense_id uuid, p_author_member_id uuid, p_description text, p_category text, p_expense_date date, p_currency character, p_amount bigint, p_split_type text, p_split_params jsonb, p_payers jsonb, p_shares jsonb, p_client_mutation_id uuid, p_notes text, p_receipt_id uuid, p_base_version_no integer, p_fx jsonb, p_source text, p_payment_method text, p_receipt_share_url text, p_category_meta jsonb, p_location jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_apply_expense(p_group_id uuid, p_expense_id uuid, p_author_member_id uuid, p_description text, p_category text, p_expense_date date, p_currency character, p_amount bigint, p_split_type text, p_split_params jsonb, p_payers jsonb, p_shares jsonb, p_client_mutation_id uuid, p_notes text, p_receipt_id uuid, p_base_version_no integer, p_fx jsonb, p_source text, p_payment_method text, p_receipt_share_url text, p_category_meta jsonb, p_location jsonb) TO service_role;


--
-- Name: FUNCTION waves_array_is_distinct(p_values text[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_array_is_distinct(p_values text[]) TO anon;
GRANT ALL ON FUNCTION public.waves_array_is_distinct(p_values text[]) TO authenticated;
GRANT ALL ON FUNCTION public.waves_array_is_distinct(p_values text[]) TO service_role;


--
-- Name: FUNCTION waves_assert_expense_caller(p_group_id uuid, p_author_member_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_assert_expense_caller(p_group_id uuid, p_author_member_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_assert_expense_caller(p_group_id uuid, p_author_member_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_assert_expense_caller(p_group_id uuid, p_author_member_id uuid) TO service_role;


--
-- Name: FUNCTION waves_assert_fx_valid(p_fx jsonb, p_expense_currency character, p_group_currency character); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_assert_fx_valid(p_fx jsonb, p_expense_currency character, p_group_currency character) TO authenticated;
GRANT ALL ON FUNCTION public.waves_assert_fx_valid(p_fx jsonb, p_expense_currency character, p_group_currency character) TO anon;


--
-- Name: FUNCTION waves_attach_expense_attachment(p_expense_id uuid, p_storage_path text, p_visibility text, p_attachment_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_attach_expense_attachment(p_expense_id uuid, p_storage_path text, p_visibility text, p_attachment_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_attach_expense_attachment(p_expense_id uuid, p_storage_path text, p_visibility text, p_attachment_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_attach_expense_attachment(p_expense_id uuid, p_storage_path text, p_visibility text, p_attachment_id uuid) TO service_role;


--
-- Name: FUNCTION waves_attach_settlement_proof(p_settlement_id uuid, p_storage_path text, p_proof_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_attach_settlement_proof(p_settlement_id uuid, p_storage_path text, p_proof_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_attach_settlement_proof(p_settlement_id uuid, p_storage_path text, p_proof_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_attach_settlement_proof(p_settlement_id uuid, p_storage_path text, p_proof_id uuid) TO service_role;


--
-- Name: FUNCTION waves_attachment_cap(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_attachment_cap() TO anon;
GRANT ALL ON FUNCTION public.waves_attachment_cap() TO authenticated;
GRANT ALL ON FUNCTION public.waves_attachment_cap() TO service_role;


--
-- Name: FUNCTION waves_auto_archive_stale_groups(p_now timestamp with time zone, p_age interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_auto_archive_stale_groups(p_now timestamp with time zone, p_age interval) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_auto_archive_stale_groups(p_now timestamp with time zone, p_age interval) TO service_role;


--
-- Name: FUNCTION waves_auto_confirm_settlements(p_now timestamp with time zone, p_window interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_auto_confirm_settlements(p_now timestamp with time zone, p_window interval) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_auto_confirm_settlements(p_now timestamp with time zone, p_window interval) TO service_role;


--
-- Name: FUNCTION waves_bucket(p_input text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_bucket(p_input text) TO anon;
GRANT ALL ON FUNCTION public.waves_bucket(p_input text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_bucket(p_input text) TO service_role;


--
-- Name: FUNCTION waves_campaign_cohort(p_campaign_id uuid, p_profile_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_campaign_cohort(p_campaign_id uuid, p_profile_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_campaign_cohort(p_campaign_id uuid, p_profile_id uuid) TO service_role;


--
-- Name: FUNCTION waves_campaign_seen(p_campaign_id uuid, p_acted boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_campaign_seen(p_campaign_id uuid, p_acted boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_campaign_seen(p_campaign_id uuid, p_acted boolean) TO authenticated;
GRANT ALL ON FUNCTION public.waves_campaign_seen(p_campaign_id uuid, p_acted boolean) TO service_role;


--
-- Name: FUNCTION waves_can_add_expense_attachment(p_expense_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_can_add_expense_attachment(p_expense_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_can_add_expense_attachment(p_expense_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_can_add_expense_attachment(p_expense_id uuid) TO service_role;


--
-- Name: FUNCTION waves_can_add_receipt(p_group_id uuid, p_receipt_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_can_add_receipt(p_group_id uuid, p_receipt_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_can_add_receipt(p_group_id uuid, p_receipt_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_can_add_receipt(p_group_id uuid, p_receipt_id uuid) TO service_role;


--
-- Name: FUNCTION waves_can_upload_group_photo(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_can_upload_group_photo(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_can_upload_group_photo(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_can_upload_group_photo(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_cancel_settlement(p_settlement_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_cancel_settlement(p_settlement_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_cancel_settlement(p_settlement_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_cancel_settlement(p_settlement_id uuid) TO service_role;


--
-- Name: FUNCTION waves_claim_campaign_emails(p_campaign_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_claim_campaign_emails(p_campaign_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_claim_campaign_emails(p_campaign_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION waves_claim_email_notifications(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_claim_email_notifications(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_claim_email_notifications(p_limit integer) TO service_role;


--
-- Name: FUNCTION waves_claim_push_notifications(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_claim_push_notifications(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_claim_push_notifications(p_limit integer) TO service_role;


--
-- Name: FUNCTION waves_clear_my_trip_budget(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_clear_my_trip_budget(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_clear_my_trip_budget(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_clear_my_trip_budget(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_close_disputes_on_new_version(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_close_disputes_on_new_version() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_close_disputes_on_new_version() TO service_role;


--
-- Name: FUNCTION waves_confirm_settlement(p_settlement_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_confirm_settlement(p_settlement_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_confirm_settlement(p_settlement_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_confirm_settlement(p_settlement_id uuid) TO service_role;


--
-- Name: FUNCTION waves_consume_invite(p_invite_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_consume_invite(p_invite_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_consume_invite(p_invite_id uuid) TO service_role;


--
-- Name: FUNCTION waves_create_group(p_name text, p_type text, p_currency character, p_emoji text, p_simplify boolean, p_group_id uuid, p_photo_path text, p_country character, p_creator_member_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_create_group(p_name text, p_type text, p_currency character, p_emoji text, p_simplify boolean, p_group_id uuid, p_photo_path text, p_country character, p_creator_member_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_create_group(p_name text, p_type text, p_currency character, p_emoji text, p_simplify boolean, p_group_id uuid, p_photo_path text, p_country character, p_creator_member_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_create_group(p_name text, p_type text, p_currency character, p_emoji text, p_simplify boolean, p_group_id uuid, p_photo_path text, p_country character, p_creator_member_id uuid) TO service_role;


--
-- Name: FUNCTION waves_decide_member_claim(p_claim_id uuid, p_approve boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_decide_member_claim(p_claim_id uuid, p_approve boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_decide_member_claim(p_claim_id uuid, p_approve boolean) TO authenticated;
GRANT ALL ON FUNCTION public.waves_decide_member_claim(p_claim_id uuid, p_approve boolean) TO service_role;


--
-- Name: FUNCTION waves_delete_expense(p_expense_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_delete_expense(p_expense_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_delete_expense(p_expense_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_delete_expense(p_expense_id uuid) TO service_role;


--
-- Name: FUNCTION waves_delete_expense_comment(p_comment_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_delete_expense_comment(p_comment_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_delete_expense_comment(p_comment_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_delete_expense_comment(p_comment_id uuid) TO service_role;


--
-- Name: FUNCTION waves_delete_group(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_delete_group(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_delete_group(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_delete_group(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_delete_my_account(p_feedback text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_delete_my_account(p_feedback text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_delete_my_account(p_feedback text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_delete_my_account(p_feedback text) TO service_role;


--
-- Name: FUNCTION waves_device_cap(p_profile_id uuid, p_is_plus boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_device_cap(p_profile_id uuid, p_is_plus boolean) TO anon;
GRANT ALL ON FUNCTION public.waves_device_cap(p_profile_id uuid, p_is_plus boolean) TO authenticated;
GRANT ALL ON FUNCTION public.waves_device_cap(p_profile_id uuid, p_is_plus boolean) TO service_role;


--
-- Name: FUNCTION waves_dispute_expense(p_expense_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_dispute_expense(p_expense_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_dispute_expense(p_expense_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_dispute_expense(p_expense_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION waves_dispute_settlement(p_settlement_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_dispute_settlement(p_settlement_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_dispute_settlement(p_settlement_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_dispute_settlement(p_settlement_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION waves_edit_expense_comment(p_comment_id uuid, p_body text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_edit_expense_comment(p_comment_id uuid, p_body text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_edit_expense_comment(p_comment_id uuid, p_body text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_edit_expense_comment(p_comment_id uuid, p_body text) TO service_role;


--
-- Name: FUNCTION waves_email_for(p_profile_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_email_for(p_profile_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_email_for(p_profile_id uuid) TO service_role;


--
-- Name: FUNCTION waves_email_suppressed(p_address text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_email_suppressed(p_address text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_email_suppressed(p_address text) TO service_role;


--
-- Name: FUNCTION waves_ensure_group_join_token(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_ensure_group_join_token(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_ensure_group_join_token(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_ensure_group_join_token(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_finish_campaign_emails(p_results jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_finish_campaign_emails(p_results jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_finish_campaign_emails(p_results jsonb) TO service_role;


--
-- Name: FUNCTION waves_finish_email(p_results jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_finish_email(p_results jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_finish_email(p_results jsonb) TO service_role;


--
-- Name: FUNCTION waves_finish_push(p_delivered uuid[], p_failed uuid[], p_revoke text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_finish_push(p_delivered uuid[], p_failed uuid[], p_revoke text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_finish_push(p_delivered uuid[], p_failed uuid[], p_revoke text[]) TO service_role;


--
-- Name: FUNCTION waves_flag_expense_comment(p_comment_id uuid, p_flag boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_flag_expense_comment(p_comment_id uuid, p_flag boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_flag_expense_comment(p_comment_id uuid, p_flag boolean) TO authenticated;
GRANT ALL ON FUNCTION public.waves_flag_expense_comment(p_comment_id uuid, p_flag boolean) TO service_role;


--
-- Name: FUNCTION waves_free_storage_cap(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_free_storage_cap() TO anon;
GRANT ALL ON FUNCTION public.waves_free_storage_cap() TO authenticated;
GRANT ALL ON FUNCTION public.waves_free_storage_cap() TO service_role;


--
-- Name: FUNCTION waves_grant_promo(p_profile_id uuid, p_days integer, p_source text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_grant_promo(p_profile_id uuid, p_days integer, p_source text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_grant_promo(p_profile_id uuid, p_days integer, p_source text) TO service_role;


--
-- Name: FUNCTION waves_gravatar_url(p_email text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_gravatar_url(p_email text) TO anon;
GRANT ALL ON FUNCTION public.waves_gravatar_url(p_email text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_gravatar_url(p_email text) TO service_role;


--
-- Name: FUNCTION waves_group_is_paid(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_group_is_paid(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_group_is_paid(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_group_is_paid(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_group_member_claims(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_group_member_claims(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_group_member_claims(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_group_member_claims(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_group_plan(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_group_plan(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_group_plan(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_group_plan(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_group_spending(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_group_spending(p_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.waves_group_spending(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_group_spending(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_guard_group_columns(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_guard_group_columns() TO anon;
GRANT ALL ON FUNCTION public.waves_guard_group_columns() TO authenticated;
GRANT ALL ON FUNCTION public.waves_guard_group_columns() TO service_role;


--
-- Name: FUNCTION waves_guard_membership_columns(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_guard_membership_columns() TO anon;
GRANT ALL ON FUNCTION public.waves_guard_membership_columns() TO authenticated;
GRANT ALL ON FUNCTION public.waves_guard_membership_columns() TO service_role;


--
-- Name: FUNCTION waves_handle_new_user(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_handle_new_user() TO service_role;


--
-- Name: FUNCTION waves_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb, p_origin text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb, p_origin text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb, p_origin text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_import_ledger(p_group_id uuid, p_people jsonb, p_expenses jsonb, p_settlements jsonb, p_origin text) TO service_role;


--
-- Name: FUNCTION waves_import_splitwise(p_group_id uuid, p_people jsonb, p_expenses jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_import_splitwise(p_group_id uuid, p_people jsonb, p_expenses jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_import_splitwise(p_group_id uuid, p_people jsonb, p_expenses jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.waves_import_splitwise(p_group_id uuid, p_people jsonb, p_expenses jsonb) TO service_role;


--
-- Name: FUNCTION waves_is_expense_party(p_expense_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_is_expense_party(p_expense_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_is_expense_party(p_expense_id uuid) TO anon;
GRANT ALL ON FUNCTION public.waves_is_expense_party(p_expense_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_is_expense_party(p_expense_id uuid) TO service_role;


--
-- Name: FUNCTION waves_is_settlement_party(p_settlement_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_is_settlement_party(p_settlement_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_is_settlement_party(p_settlement_id uuid) TO anon;
GRANT ALL ON FUNCTION public.waves_is_settlement_party(p_settlement_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_is_settlement_party(p_settlement_id uuid) TO service_role;


--
-- Name: FUNCTION waves_item_claims(p_receipt_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_item_claims(p_receipt_id uuid) TO anon;
GRANT ALL ON FUNCTION public.waves_item_claims(p_receipt_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_item_claims(p_receipt_id uuid) TO service_role;


--
-- Name: FUNCTION waves_list_devices(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_list_devices() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_list_devices() TO authenticated;
GRANT ALL ON FUNCTION public.waves_list_devices() TO service_role;


--
-- Name: FUNCTION waves_log_receipt_event(p_event_id uuid, p_group_id uuid, p_expense_id uuid, p_action text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_log_receipt_event(p_event_id uuid, p_group_id uuid, p_expense_id uuid, p_action text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_log_receipt_event(p_event_id uuid, p_group_id uuid, p_expense_id uuid, p_action text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_log_receipt_event(p_event_id uuid, p_group_id uuid, p_expense_id uuid, p_action text) TO service_role;


--
-- Name: FUNCTION waves_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.waves_log_voice_attempt(p_transcript text, p_locale text, p_used_model boolean, p_item_count integer, p_platform text, p_app_version text, p_client_at timestamp with time zone) TO service_role;


--
-- Name: FUNCTION waves_mark_notifications_read(p_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_mark_notifications_read(p_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.waves_mark_notifications_read(p_ids uuid[]) TO anon;


--
-- Name: FUNCTION waves_member_group_id(p_member_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_member_group_id(p_member_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_member_group_id(p_member_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_member_group_id(p_member_id uuid) TO service_role;


--
-- Name: FUNCTION waves_merge_ghosts(p_member_ids uuid[], p_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_merge_ghosts(p_member_ids uuid[], p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_merge_ghosts(p_member_ids uuid[], p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_merge_ghosts(p_member_ids uuid[], p_name text) TO service_role;


--
-- Name: FUNCTION waves_my_campaign(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_my_campaign() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_my_campaign() TO authenticated;
GRANT ALL ON FUNCTION public.waves_my_campaign() TO service_role;


--
-- Name: FUNCTION waves_my_erasure_preview(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_my_erasure_preview() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_my_erasure_preview() TO authenticated;
GRANT ALL ON FUNCTION public.waves_my_erasure_preview() TO service_role;


--
-- Name: FUNCTION waves_my_member_claims(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_my_member_claims() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_my_member_claims() TO authenticated;
GRANT ALL ON FUNCTION public.waves_my_member_claims() TO service_role;


--
-- Name: FUNCTION waves_my_member_id(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_my_member_id(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_my_member_id(p_group_id uuid) TO anon;


--
-- Name: FUNCTION waves_my_member_id_for(p_group_id uuid, p_profile_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_my_member_id_for(p_group_id uuid, p_profile_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_my_member_id_for(p_group_id uuid, p_profile_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_my_member_id_for(p_group_id uuid, p_profile_id uuid) TO service_role;


--
-- Name: FUNCTION waves_my_plan(p_profile_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_my_plan(p_profile_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_my_plan(p_profile_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_my_plan(p_profile_id uuid) TO service_role;


--
-- Name: FUNCTION waves_my_storage_usage(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_my_storage_usage() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_my_storage_usage() TO authenticated;
GRANT ALL ON FUNCTION public.waves_my_storage_usage() TO service_role;


--
-- Name: FUNCTION waves_my_voice_access(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_my_voice_access() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_my_voice_access() TO authenticated;
GRANT ALL ON FUNCTION public.waves_my_voice_access() TO service_role;


--
-- Name: FUNCTION waves_new_group_join_token(p_group_id uuid, p_revoke_existing boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_new_group_join_token(p_group_id uuid, p_revoke_existing boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_new_group_join_token(p_group_id uuid, p_revoke_existing boolean) TO service_role;


--
-- Name: FUNCTION waves_next_capture_seq(p_owner uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_next_capture_seq(p_owner uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_next_capture_seq(p_owner uuid) TO service_role;


--
-- Name: FUNCTION waves_next_category_tag_seq(p_owner uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_next_category_tag_seq(p_owner uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_next_category_tag_seq(p_owner uuid) TO service_role;


--
-- Name: FUNCTION waves_next_ghost_merge_seq(p_owner uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_next_ghost_merge_seq(p_owner uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_next_ghost_merge_seq(p_owner uuid) TO service_role;


--
-- Name: FUNCTION waves_next_group_seq(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_next_group_seq(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_next_group_seq(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_next_personal_seq(p_owner uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_next_personal_seq(p_owner uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_next_personal_seq(p_owner uuid) TO service_role;


--
-- Name: FUNCTION waves_notify(p_profile_id uuid, p_group_id uuid, p_kind text, p_title text, p_body text, p_deep_link text, p_payload jsonb, p_dedupe_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_notify(p_profile_id uuid, p_group_id uuid, p_kind text, p_title text, p_body text, p_deep_link text, p_payload jsonb, p_dedupe_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_notify(p_profile_id uuid, p_group_id uuid, p_kind text, p_title text, p_body text, p_deep_link text, p_payload jsonb, p_dedupe_key text) TO service_role;


--
-- Name: FUNCTION waves_notify_fanout_trigger(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_notify_fanout_trigger() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_notify_fanout_trigger() TO service_role;


--
-- Name: FUNCTION waves_nudge_to_settle(p_group_id uuid, p_to_member_id uuid, p_currency character); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_nudge_to_settle(p_group_id uuid, p_to_member_id uuid, p_currency character) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_nudge_to_settle(p_group_id uuid, p_to_member_id uuid, p_currency character) TO authenticated;
GRANT ALL ON FUNCTION public.waves_nudge_to_settle(p_group_id uuid, p_to_member_id uuid, p_currency character) TO service_role;


--
-- Name: FUNCTION waves_open_receipts(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_open_receipts(p_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.waves_open_receipts(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_open_receipts(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_people_i_owe(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_people_i_owe() TO anon;
GRANT ALL ON FUNCTION public.waves_people_i_owe() TO authenticated;
GRANT ALL ON FUNCTION public.waves_people_i_owe() TO service_role;


--
-- Name: FUNCTION waves_person_group_balances(p_person_key text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_person_group_balances(p_person_key text) TO anon;
GRANT ALL ON FUNCTION public.waves_person_group_balances(p_person_key text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_person_group_balances(p_person_key text) TO service_role;


--
-- Name: FUNCTION waves_profile_is_paid(p_profile uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_profile_is_paid(p_profile uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_profile_is_paid(p_profile uuid) TO service_role;


--
-- Name: FUNCTION waves_profiles_share_group(p_a uuid, p_b uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_profiles_share_group(p_a uuid, p_b uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_profiles_share_group(p_a uuid, p_b uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_profiles_share_group(p_a uuid, p_b uuid) TO service_role;


--
-- Name: FUNCTION waves_publish_receipt_items(p_receipt_id uuid, p_items jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_publish_receipt_items(p_receipt_id uuid, p_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_publish_receipt_items(p_receipt_id uuid, p_items jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.waves_publish_receipt_items(p_receipt_id uuid, p_items jsonb) TO service_role;


--
-- Name: FUNCTION waves_rate_limit(p_subject text, p_bucket text, p_limit integer, p_window_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_rate_limit(p_subject text, p_bucket text, p_limit integer, p_window_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_rate_limit(p_subject text, p_bucket text, p_limit integer, p_window_seconds integer) TO service_role;


--
-- Name: FUNCTION waves_receipt_cap(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_receipt_cap() TO anon;
GRANT ALL ON FUNCTION public.waves_receipt_cap() TO authenticated;
GRANT ALL ON FUNCTION public.waves_receipt_cap() TO service_role;


--
-- Name: FUNCTION waves_receipt_scan_quota(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_receipt_scan_quota() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_receipt_scan_quota() TO authenticated;
GRANT ALL ON FUNCTION public.waves_receipt_scan_quota() TO service_role;


--
-- Name: FUNCTION waves_record_email_event(p_resend_email_id text, p_event text, p_address text, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_record_email_event(p_resend_email_id text, p_event text, p_address text, p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_record_email_event(p_resend_email_id text, p_event text, p_address text, p_payload jsonb) TO service_role;


--
-- Name: FUNCTION waves_record_receipt(p_group_id uuid, p_receipt_id uuid, p_profile_id uuid, p_source text, p_storage_path text, p_raw_text text, p_parsed jsonb, p_status text, p_input_tokens integer, p_output_tokens integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_record_receipt(p_group_id uuid, p_receipt_id uuid, p_profile_id uuid, p_source text, p_storage_path text, p_raw_text text, p_parsed jsonb, p_status text, p_input_tokens integer, p_output_tokens integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_record_receipt(p_group_id uuid, p_receipt_id uuid, p_profile_id uuid, p_source text, p_storage_path text, p_raw_text text, p_parsed jsonb, p_status text, p_input_tokens integer, p_output_tokens integer) TO service_role;


--
-- Name: FUNCTION waves_record_settlement(p_group_id uuid, p_from_member_id uuid, p_to_member_id uuid, p_amount bigint, p_method text, p_currency character, p_note text, p_allocations jsonb, p_client_mutation_id uuid, p_rail text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_record_settlement(p_group_id uuid, p_from_member_id uuid, p_to_member_id uuid, p_amount bigint, p_method text, p_currency character, p_note text, p_allocations jsonb, p_client_mutation_id uuid, p_rail text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_record_settlement(p_group_id uuid, p_from_member_id uuid, p_to_member_id uuid, p_amount bigint, p_method text, p_currency character, p_note text, p_allocations jsonb, p_client_mutation_id uuid, p_rail text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_record_settlement(p_group_id uuid, p_from_member_id uuid, p_to_member_id uuid, p_amount bigint, p_method text, p_currency character, p_note text, p_allocations jsonb, p_client_mutation_id uuid, p_rail text) TO service_role;


--
-- Name: FUNCTION waves_redeem_promo(p_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_redeem_promo(p_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_redeem_promo(p_code text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_redeem_promo(p_code text) TO service_role;


--
-- Name: FUNCTION waves_refresh_group_balances(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_refresh_group_balances(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_refresh_group_balances(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_register_device(p_device_id text, p_label text, p_platform text, p_app_version text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_register_device(p_device_id text, p_label text, p_platform text, p_app_version text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_register_device(p_device_id text, p_label text, p_platform text, p_app_version text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_register_device(p_device_id text, p_label text, p_platform text, p_app_version text) TO service_role;


--
-- Name: FUNCTION waves_remove_expense_attachment(p_attachment_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_remove_expense_attachment(p_attachment_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_remove_expense_attachment(p_attachment_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_remove_expense_attachment(p_attachment_id uuid) TO service_role;


--
-- Name: FUNCTION waves_remove_plan_item(p_item_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_remove_plan_item(p_item_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_remove_plan_item(p_item_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_remove_plan_item(p_item_id uuid) TO service_role;


--
-- Name: FUNCTION waves_remove_settlement_proof(p_proof_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_remove_settlement_proof(p_proof_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_remove_settlement_proof(p_proof_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_remove_settlement_proof(p_proof_id uuid) TO service_role;


--
-- Name: FUNCTION waves_remove_trip_photo(p_photo_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_remove_trip_photo(p_photo_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_remove_trip_photo(p_photo_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_remove_trip_photo(p_photo_id uuid) TO service_role;


--
-- Name: FUNCTION waves_replace_expense_attachment_image(p_attachment_id uuid, p_new_path text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_replace_expense_attachment_image(p_attachment_id uuid, p_new_path text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_replace_expense_attachment_image(p_attachment_id uuid, p_new_path text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_replace_expense_attachment_image(p_attachment_id uuid, p_new_path text) TO service_role;


--
-- Name: FUNCTION waves_request_member_claim(p_group_id uuid, p_member_id uuid, p_profile_id uuid, p_name text, p_invite_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_request_member_claim(p_group_id uuid, p_member_id uuid, p_profile_id uuid, p_name text, p_invite_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_request_member_claim(p_group_id uuid, p_member_id uuid, p_profile_id uuid, p_name text, p_invite_id uuid) TO service_role;


--
-- Name: FUNCTION waves_require_committed_object(p_logical_bucket text, p_path text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_require_committed_object(p_logical_bucket text, p_path text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_require_committed_object(p_logical_bucket text, p_path text) TO service_role;


--
-- Name: FUNCTION waves_reset_group_join_token(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_reset_group_join_token(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_reset_group_join_token(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_reset_group_join_token(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_resolve_dispute(p_dispute_id uuid, p_accept boolean, p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_resolve_dispute(p_dispute_id uuid, p_accept boolean, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_resolve_dispute(p_dispute_id uuid, p_accept boolean, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_resolve_dispute(p_dispute_id uuid, p_accept boolean, p_note text) TO service_role;


--
-- Name: FUNCTION waves_restore_expense(p_expense_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_restore_expense(p_expense_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_restore_expense(p_expense_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_restore_expense(p_expense_id uuid) TO service_role;


--
-- Name: FUNCTION waves_scans_used_this_month(p_profile_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_scans_used_this_month(p_profile_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_scans_used_this_month(p_profile_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_scans_used_this_month(p_profile_id uuid) TO service_role;


--
-- Name: FUNCTION waves_set_category_budget(p_group_id uuid, p_category text, p_amount_minor bigint, p_currency character); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_set_category_budget(p_group_id uuid, p_category text, p_amount_minor bigint, p_currency character) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_set_category_budget(p_group_id uuid, p_category text, p_amount_minor bigint, p_currency character) TO authenticated;
GRANT ALL ON FUNCTION public.waves_set_category_budget(p_group_id uuid, p_category text, p_amount_minor bigint, p_currency character) TO service_role;


--
-- Name: FUNCTION waves_set_group_budget(p_group_id uuid, p_amount_minor bigint, p_currency character); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_set_group_budget(p_group_id uuid, p_amount_minor bigint, p_currency character) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_set_group_budget(p_group_id uuid, p_amount_minor bigint, p_currency character) TO authenticated;
GRANT ALL ON FUNCTION public.waves_set_group_budget(p_group_id uuid, p_amount_minor bigint, p_currency character) TO service_role;


--
-- Name: FUNCTION waves_set_group_fx_rate(p_group_id uuid, p_from character, p_num bigint, p_den bigint, p_source text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_set_group_fx_rate(p_group_id uuid, p_from character, p_num bigint, p_den bigint, p_source text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_set_group_fx_rate(p_group_id uuid, p_from character, p_num bigint, p_den bigint, p_source text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_set_group_fx_rate(p_group_id uuid, p_from character, p_num bigint, p_den bigint, p_source text) TO service_role;


--
-- Name: FUNCTION waves_set_item_claim(p_receipt_id uuid, p_item_index integer, p_claimed boolean, p_for_member_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_set_item_claim(p_receipt_id uuid, p_item_index integer, p_claimed boolean, p_for_member_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_set_item_claim(p_receipt_id uuid, p_item_index integer, p_claimed boolean, p_for_member_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_set_item_claim(p_receipt_id uuid, p_item_index integer, p_claimed boolean, p_for_member_id uuid) TO service_role;


--
-- Name: FUNCTION waves_set_member_role(p_member_id uuid, p_role text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_set_member_role(p_member_id uuid, p_role text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_set_member_role(p_member_id uuid, p_role text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_set_member_role(p_member_id uuid, p_role text) TO service_role;


--
-- Name: FUNCTION waves_set_my_trip_budget(p_group_id uuid, p_amount_minor bigint, p_currency character, p_visibility text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_set_my_trip_budget(p_group_id uuid, p_amount_minor bigint, p_currency character, p_visibility text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_set_my_trip_budget(p_group_id uuid, p_amount_minor bigint, p_currency character, p_visibility text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_set_my_trip_budget(p_group_id uuid, p_amount_minor bigint, p_currency character, p_visibility text) TO service_role;


--
-- Name: FUNCTION waves_shares_a_group_with(p_profile_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_shares_a_group_with(p_profile_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_shares_a_group_with(p_profile_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_shares_a_group_with(p_profile_id uuid) TO service_role;


--
-- Name: FUNCTION waves_sign_out_other_devices(p_device_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_sign_out_other_devices(p_device_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_sign_out_other_devices(p_device_id text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_sign_out_other_devices(p_device_id text) TO service_role;


--
-- Name: FUNCTION waves_stamp_capture_seq(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_stamp_capture_seq() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_stamp_capture_seq() TO service_role;


--
-- Name: FUNCTION waves_stamp_category_tag_seq(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_stamp_category_tag_seq() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_stamp_category_tag_seq() TO service_role;


--
-- Name: FUNCTION waves_stamp_ghost_merge_seq(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_stamp_ghost_merge_seq() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_stamp_ghost_merge_seq() TO service_role;


--
-- Name: FUNCTION waves_stamp_group_seq(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_stamp_group_seq() FROM PUBLIC;


--
-- Name: FUNCTION waves_stamp_personal_seq(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_stamp_personal_seq() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_stamp_personal_seq() TO service_role;


--
-- Name: FUNCTION waves_stamp_seq(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_stamp_seq() FROM PUBLIC;


--
-- Name: FUNCTION waves_storage_counts(p_profile_id uuid, p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_counts(p_profile_id uuid, p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_counts(p_profile_id uuid, p_group_id uuid) TO service_role;


--
-- Name: FUNCTION waves_storage_enqueue_orphan(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_enqueue_orphan() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_enqueue_orphan() TO service_role;


--
-- Name: FUNCTION waves_storage_expire_pending(p_age interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_expire_pending(p_age interval) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_expire_pending(p_age interval) TO service_role;


--
-- Name: FUNCTION waves_storage_orphan_clear(p_logical_bucket text, p_path text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_orphan_clear(p_logical_bucket text, p_path text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_orphan_clear(p_logical_bucket text, p_path text) TO service_role;


--
-- Name: FUNCTION waves_storage_orphans(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_orphans(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_orphans(p_limit integer) TO service_role;


--
-- Name: FUNCTION waves_storage_record(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_record(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_record(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) TO service_role;


--
-- Name: FUNCTION waves_storage_recount(p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_recount(p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_recount(p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) TO service_role;


--
-- Name: FUNCTION waves_storage_release(p_logical_bucket text, p_path text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_release(p_logical_bucket text, p_path text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_release(p_logical_bucket text, p_path text) TO service_role;


--
-- Name: FUNCTION waves_storage_release_reservation(p_logical_bucket text, p_path text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_release_reservation(p_logical_bucket text, p_path text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_release_reservation(p_logical_bucket text, p_path text) TO service_role;


--
-- Name: FUNCTION waves_storage_reserve(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_storage_reserve(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_storage_reserve(p_profile_id uuid, p_group_id uuid, p_logical_bucket text, p_path text, p_bytes bigint, p_content_type text) TO service_role;


--
-- Name: FUNCTION waves_submit_feedback(p_message text, p_kind text, p_rating integer, p_app_version text, p_platform text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_submit_feedback(p_message text, p_kind text, p_rating integer, p_app_version text, p_platform text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_submit_feedback(p_message text, p_kind text, p_rating integer, p_app_version text, p_platform text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_submit_feedback(p_message text, p_kind text, p_rating integer, p_app_version text, p_platform text) TO service_role;


--
-- Name: FUNCTION waves_suppress_email(p_address text, p_reason text, p_detail jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_suppress_email(p_address text, p_reason text, p_detail jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_suppress_email(p_address text, p_reason text, p_detail jsonb) TO service_role;


--
-- Name: FUNCTION waves_sweep_rate_limits(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_sweep_rate_limits() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_sweep_rate_limits() TO service_role;


--
-- Name: FUNCTION waves_touch_balances(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_touch_balances() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_touch_balances() TO service_role;


--
-- Name: FUNCTION waves_trip_nudges(p_now timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_trip_nudges(p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_trip_nudges(p_now timestamp with time zone) TO service_role;


--
-- Name: FUNCTION waves_update_plan_item(p_item_id uuid, p_day date, p_starts_at time without time zone, p_title text, p_note text, p_category text, p_planned_minor bigint, p_done boolean, p_expense_id uuid, p_clear text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_update_plan_item(p_item_id uuid, p_day date, p_starts_at time without time zone, p_title text, p_note text, p_category text, p_planned_minor bigint, p_done boolean, p_expense_id uuid, p_clear text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_update_plan_item(p_item_id uuid, p_day date, p_starts_at time without time zone, p_title text, p_note text, p_category text, p_planned_minor bigint, p_done boolean, p_expense_id uuid, p_clear text[]) TO authenticated;
GRANT ALL ON FUNCTION public.waves_update_plan_item(p_item_id uuid, p_day date, p_starts_at time without time zone, p_title text, p_note text, p_category text, p_planned_minor bigint, p_done boolean, p_expense_id uuid, p_clear text[]) TO service_role;


--
-- Name: FUNCTION waves_variant(p_key text, p_profile_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_variant(p_key text, p_profile_id uuid) TO anon;
GRANT ALL ON FUNCTION public.waves_variant(p_key text, p_profile_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_variant(p_key text, p_profile_id uuid) TO service_role;


--
-- Name: FUNCTION waves_version_key(p_version text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.waves_version_key(p_version text) TO anon;
GRANT ALL ON FUNCTION public.waves_version_key(p_version text) TO authenticated;
GRANT ALL ON FUNCTION public.waves_version_key(p_version text) TO service_role;


--
-- Name: FUNCTION waves_voice_stt_free_seconds(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_voice_stt_free_seconds() FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_voice_stt_free_seconds() TO authenticated;
GRANT ALL ON FUNCTION public.waves_voice_stt_free_seconds() TO service_role;


--
-- Name: FUNCTION waves_voice_stt_record(p_profile uuid, p_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_voice_stt_record(p_profile uuid, p_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_voice_stt_record(p_profile uuid, p_seconds integer) TO service_role;


--
-- Name: FUNCTION waves_voice_stt_remaining_seconds(p_profile uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_voice_stt_remaining_seconds(p_profile uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_voice_stt_remaining_seconds(p_profile uuid) TO service_role;


--
-- Name: FUNCTION waves_withdraw_dispute(p_expense_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_withdraw_dispute(p_expense_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_withdraw_dispute(p_expense_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_withdraw_dispute(p_expense_id uuid) TO service_role;


--
-- Name: FUNCTION waves_withdraw_member_claim(p_claim_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.waves_withdraw_member_claim(p_claim_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.waves_withdraw_member_claim(p_claim_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.waves_withdraw_member_claim(p_claim_id uuid) TO service_role;


--
-- Name: TABLE activity_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.activity_log TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activity_log TO service_role;


--
-- Name: TABLE app_config; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.app_config TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.app_config TO service_role;


--
-- Name: TABLE app_releases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.app_releases TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.app_releases TO service_role;
GRANT SELECT ON TABLE public.app_releases TO anon;


--
-- Name: TABLE campaign_email_sends; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.campaign_email_sends TO service_role;


--
-- Name: TABLE campaign_impressions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.campaign_impressions TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.campaign_impressions TO service_role;


--
-- Name: TABLE campaigns; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.campaigns TO service_role;


--
-- Name: TABLE captures; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.captures TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.captures TO authenticated;


--
-- Name: TABLE category_tags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.category_tags TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.category_tags TO authenticated;


--
-- Name: TABLE country_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.country_settings TO anon;
GRANT SELECT ON TABLE public.country_settings TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.country_settings TO service_role;


--
-- Name: TABLE device_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.device_sessions TO service_role;
GRANT SELECT ON TABLE public.device_sessions TO authenticated;


--
-- Name: TABLE email_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.email_events TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_events TO service_role;


--
-- Name: TABLE email_suppressions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_suppressions TO service_role;


--
-- Name: TABLE expense_attachments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expense_attachments TO service_role;
GRANT SELECT ON TABLE public.expense_attachments TO authenticated;


--
-- Name: TABLE expense_comments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expense_comments TO service_role;
GRANT SELECT ON TABLE public.expense_comments TO authenticated;


--
-- Name: TABLE expense_disputes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.expense_disputes TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expense_disputes TO service_role;


--
-- Name: TABLE expense_image_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expense_image_events TO service_role;
GRANT SELECT ON TABLE public.expense_image_events TO authenticated;


--
-- Name: TABLE expense_payers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.expense_payers TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expense_payers TO service_role;


--
-- Name: TABLE expense_shares; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.expense_shares TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expense_shares TO service_role;


--
-- Name: TABLE expense_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.expense_versions TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expense_versions TO service_role;


--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.expenses TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expenses TO service_role;


--
-- Name: TABLE feature_flags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.feature_flags TO anon;
GRANT SELECT ON TABLE public.feature_flags TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.feature_flags TO service_role;


--
-- Name: TABLE feedback; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.feedback TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.feedback TO service_role;


--
-- Name: TABLE ghost_merges; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ghost_merges TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ghost_merges TO service_role;


--
-- Name: TABLE group_balances; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.group_balances TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_balances TO service_role;


--
-- Name: TABLE group_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.group_members TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_members TO service_role;


--
-- Name: TABLE group_passes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_passes TO service_role;
GRANT SELECT ON TABLE public.group_passes TO authenticated;


--
-- Name: TABLE groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.groups TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.groups TO service_role;


--
-- Name: TABLE invites; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.invites TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invites TO service_role;


--
-- Name: TABLE member_claims; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.member_claims TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.member_claims TO service_role;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.notifications TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO service_role;


--
-- Name: TABLE pairwise_balances; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.pairwise_balances TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pairwise_balances TO service_role;


--
-- Name: TABLE personal_records; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.personal_records TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.personal_records TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.profiles TO service_role;


--
-- Name: TABLE promo_codes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.promo_codes TO service_role;


--
-- Name: TABLE promo_redemptions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.promo_redemptions TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.promo_redemptions TO service_role;


--
-- Name: TABLE push_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.push_tokens TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_tokens TO service_role;


--
-- Name: TABLE rate_limit_hits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rate_limit_hits TO service_role;


--
-- Name: TABLE rate_limit_rules; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rate_limit_rules TO service_role;


--
-- Name: TABLE rate_limit_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rate_limit_settings TO service_role;


--
-- Name: TABLE receipt_item_claims; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.receipt_item_claims TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.receipt_item_claims TO service_role;


--
-- Name: TABLE receipts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.receipts TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.receipts TO service_role;


--
-- Name: TABLE reminders; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.reminders TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.reminders TO service_role;


--
-- Name: TABLE service_config; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.service_config TO service_role;
GRANT SELECT ON TABLE public.service_config TO authenticated;


--
-- Name: TABLE settlement_allocations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.settlement_allocations TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.settlement_allocations TO service_role;


--
-- Name: TABLE settlement_proofs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.settlement_proofs TO service_role;
GRANT SELECT ON TABLE public.settlement_proofs TO authenticated;


--
-- Name: TABLE settlements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.settlements TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.settlements TO service_role;


--
-- Name: TABLE storage_objects; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.storage_objects TO service_role;


--
-- Name: TABLE storage_orphans; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.storage_orphans TO service_role;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO service_role;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;


--
-- Name: TABLE sync_mutations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.sync_mutations TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sync_mutations TO service_role;


--
-- Name: TABLE trip_member_budgets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.trip_member_budgets TO service_role;
GRANT SELECT ON TABLE public.trip_member_budgets TO authenticated;


--
-- Name: TABLE trip_photos; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.trip_photos TO service_role;
GRANT SELECT ON TABLE public.trip_photos TO authenticated;


--
-- Name: TABLE trip_plan_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.trip_plan_items TO service_role;
GRANT SELECT ON TABLE public.trip_plan_items TO authenticated;


--
-- Name: TABLE usage_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.usage_events TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_events TO service_role;


--
-- Name: TABLE voice_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.voice_attempts TO service_role;
GRANT INSERT ON TABLE public.voice_attempts TO authenticated;


--
-- Name: TABLE voice_stt_usage; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.voice_stt_usage TO service_role;
GRANT SELECT ON TABLE public.voice_stt_usage TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--



-- ────────────────────────────────────────────── reference data ──
-- Rows the app and the tests read as configuration rather than as anybody's
-- data: the config knobs, the release policy, the feature flags and the rate
-- limits. A schema-only dump leaves them out.
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: app_config; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.app_config (key, value, description, updated_at) VALUES ('receipt_cap_per_group', 3, 'Free receipts a group may hold before it must upgrade or add storage.', '2026-08-26 13:27:13.686044+00');
INSERT INTO public.app_config (key, value, description, updated_at) VALUES ('free_storage_cap_bytes', 10485760, 'Total image bytes a free account may store in R2 before it must upgrade.', '2026-08-26 13:27:13.882808+00');
INSERT INTO public.app_config (key, value, description, updated_at) VALUES ('attachment_cap_per_expense', 2, 'Free gallery receipts an expense may hold before the group must upgrade.', '2026-08-26 13:27:14.171781+00');
INSERT INTO public.app_config (key, value, description, updated_at) VALUES ('voice_stt_free_seconds', 300, 'Free cloud speech-to-text talk-time per calendar month, in seconds.', '2026-08-26 13:27:14.193543+00');
INSERT INTO public.app_config (key, value, description, updated_at) VALUES ('voice_stt_max_clip_seconds', 60, 'Hard cap on the audio length of a single cloud STT request, in seconds.', '2026-08-26 13:27:14.193543+00');
INSERT INTO public.app_config (key, value, description, updated_at) VALUES ('voice_llm_schema_version', 1, 'Version of the structured voice output contract the server emits.', '2026-08-26 13:27:14.193543+00');
INSERT INTO public.app_config (key, value, description, updated_at) VALUES ('device_cap_free', 2, 'Devices a free account may sign in on at once before the soft over-limit gate appears.', '2026-08-26 13:27:14.222797+00');
INSERT INTO public.app_config (key, value, description, updated_at) VALUES ('device_cap_plus', 3, 'Devices a paid (Plus) account may sign in on at once before the soft over-limit gate appears.', '2026-08-26 13:27:14.222797+00');


--
-- Data for Name: app_releases; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.app_releases (platform, latest_version, minimum_version, store_url, message, updated_at) VALUES ('android', '0.1.0', '0.1.0', 'https://play.google.com/store/apps/details?id=app.waves.mobile', NULL, '2026-08-26 13:27:12.474675+00');
INSERT INTO public.app_releases (platform, latest_version, minimum_version, store_url, message, updated_at) VALUES ('ios', '0.1.0', '0.1.0', 'https://apps.apple.com/app/waves/id0000000000', NULL, '2026-08-26 13:27:12.474675+00');


--
-- Data for Name: feature_flags; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.feature_flags (key, description, enabled, rollout_percent, variants, created_at, updated_at) VALUES ('sms_inbox_read', 'Android only: read bank SMS from the inbox (READ_SMS) instead of pasting. Ships dormant; switch on to roll the native reader out to a cohort.', false, 0, '{control,treatment}', '2026-08-26 13:27:13.304782+00', '2026-08-26 13:27:13.304782+00');
INSERT INTO public.feature_flags (key, description, enabled, rollout_percent, variants, created_at, updated_at) VALUES ('device_cap_free_ab', 'Experiment on the free device cap. Arms are the number of devices; enrolled accounts get their arm instead of the device_cap_free knob.', false, 0, '{2,3}', '2026-08-26 13:27:14.224623+00', '2026-08-26 13:27:14.224623+00');
INSERT INTO public.feature_flags (key, description, enabled, rollout_percent, variants, created_at, updated_at) VALUES ('device_cap_plus_ab', 'Experiment on the paid device cap. Arms are the number of devices; enrolled accounts get their arm instead of the device_cap_plus knob.', false, 0, '{3,5}', '2026-08-26 13:27:14.224623+00', '2026-08-26 13:27:14.224623+00');


--
-- Data for Name: rate_limit_rules; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.rate_limit_rules (bucket, enabled, max_calls, window_seconds, updated_at) VALUES ('sync', true, 120, 60, '2026-08-26 13:27:13.210493+00');
INSERT INTO public.rate_limit_rules (bucket, enabled, max_calls, window_seconds, updated_at) VALUES ('expense-write', true, 60, 60, '2026-08-26 13:27:13.210493+00');
INSERT INTO public.rate_limit_rules (bucket, enabled, max_calls, window_seconds, updated_at) VALUES ('export-data', true, 10, 3600, '2026-08-26 13:27:13.210493+00');
INSERT INTO public.rate_limit_rules (bucket, enabled, max_calls, window_seconds, updated_at) VALUES ('fx-rate', true, 60, 60, '2026-08-26 13:27:13.210493+00');
INSERT INTO public.rate_limit_rules (bucket, enabled, max_calls, window_seconds, updated_at) VALUES ('invite-mint', true, 30, 3600, '2026-08-26 13:27:13.210493+00');
INSERT INTO public.rate_limit_rules (bucket, enabled, max_calls, window_seconds, updated_at) VALUES ('invite-accept', true, 30, 3600, '2026-08-26 13:27:13.210493+00');
INSERT INTO public.rate_limit_rules (bucket, enabled, max_calls, window_seconds, updated_at) VALUES ('receipt-parse', true, 10, 60, '2026-08-26 13:27:13.210493+00');


--
-- Data for Name: rate_limit_settings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.rate_limit_settings (id, enabled, updated_at) VALUES (true, true, '2026-08-26 13:27:13.204269+00');


--
-- Data for Name: service_config; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.service_config (key, value, description, updated_at) VALUES ('voice_stt_provider', 'deepgram', 'Cloud STT provider adapter: deepgram | gemini.', '2026-08-26 13:27:14.193543+00');
INSERT INTO public.service_config (key, value, description, updated_at) VALUES ('voice_stt_model', '', 'Provider model id for STT (empty = provider default).', '2026-08-26 13:27:14.193543+00');
INSERT INTO public.service_config (key, value, description, updated_at) VALUES ('voice_llm_provider', '', 'Managed LLM provider for voice structuring.', '2026-08-26 13:27:14.193543+00');
INSERT INTO public.service_config (key, value, description, updated_at) VALUES ('voice_llm_model', '', 'Managed LLM model id for voice structuring.', '2026-08-26 13:27:14.193543+00');


--
-- PostgreSQL database dump complete
--

-- ──────────────────────────────────────────────────── object storage ──
-- Buckets and their row policies. This is the one part of the schema that does
-- not live in `public`: `storage` belongs to Supabase, and a plain Postgres —
-- CI, a laptop — has no such schema at all. Every block below is guarded on it
-- existing and says so and skips when it does not, which is why a schema-only
-- dump of a local database could never carry them.
--
-- Order matters. The photo-gate rewrite of the group-photo write policies comes
-- after the policies it replaces, and the signed-out hardening comes last,
-- because it narrows every policy above it to `authenticated`.

-- from 20260805120000_nameless_groups_and_photos
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the photo bucket';
    RETURN;
  END IF;

  -- Private, not public. A group photo is a picture of somebody's friends on
  -- holiday; it is read through a signed URL by people in the group and by
  -- nobody else (ADR-013). 5 MB and three image types is enough for a cover
  -- and keeps the free tier's storage honest (ADR-011).
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('group-photos', 'group-photos', false, 5242880,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "group photos are readable by members" ON storage.objects;
    CREATE POLICY "group photos are readable by members" ON storage.objects
      FOR SELECT TO authenticated, anon
      USING (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "group photos are writable by members" ON storage.objects;
    CREATE POLICY "group photos are writable by members" ON storage.objects
      FOR INSERT TO authenticated, anon
      WITH CHECK (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "group photos are replaceable by members" ON storage.objects;
    CREATE POLICY "group photos are replaceable by members" ON storage.objects
      FOR UPDATE TO authenticated, anon
      USING (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "group photos are removable by members" ON storage.objects;
    CREATE POLICY "group photos are removable by members" ON storage.objects
      FOR DELETE TO authenticated, anon
      USING (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
      );
  $policy$;
END
$$;

-- from 20260805140000_receipt_scanning
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the receipts bucket';
    RETURN;
  END IF;

  -- Private. A receipt is a record of what somebody ate and where they were;
  -- it is readable by the group it belongs to and nobody else (ADR-013).
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('receipts', 'receipts', false, 10485760,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "receipts are readable by members" ON storage.objects;
    CREATE POLICY "receipts are readable by members" ON storage.objects
      FOR SELECT TO authenticated, anon
      USING (
        bucket_id = 'receipts'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "receipts are writable by members" ON storage.objects;
    CREATE POLICY "receipts are writable by members" ON storage.objects
      FOR INSERT TO authenticated, anon
      WITH CHECK (
        bucket_id = 'receipts'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "receipts are removable by members" ON storage.objects;
    CREATE POLICY "receipts are removable by members" ON storage.objects
      FOR DELETE TO authenticated, anon
      USING (
        bucket_id = 'receipts'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
      );
  $policy$;
END
$$;

-- from 20260806210000_profile_avatars
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the avatar bucket';
    RETURN;
  END IF;

  -- 2 MB, not the 5 MB a group cover gets. An avatar is displayed at 78pt at
  -- its largest; the client downscales to 512px before it ever gets here, and
  -- the ceiling exists to catch the case where it did not (ADR-011).
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('avatars', 'avatars', false, 2097152,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "avatars are readable by people you split with" ON storage.objects;
    CREATE POLICY "avatars are readable by people you split with" ON storage.objects
      FOR SELECT TO authenticated, anon
      USING (
        bucket_id = 'avatars'
        AND public.waves_shares_a_group_with(public.waves_group_from_storage_path(name))
      );

    -- Writes are self-only. Reading a groupmate's face is ordinary; replacing
    -- it is impersonation.
    DROP POLICY IF EXISTS "avatars are writable by their owner" ON storage.objects;
    CREATE POLICY "avatars are writable by their owner" ON storage.objects
      FOR INSERT TO authenticated, anon
      WITH CHECK (
        bucket_id = 'avatars'
        AND public.waves_group_from_storage_path(name) = public.waves_current_profile_id()
      );

    DROP POLICY IF EXISTS "avatars are replaceable by their owner" ON storage.objects;
    CREATE POLICY "avatars are replaceable by their owner" ON storage.objects
      FOR UPDATE TO authenticated, anon
      USING (
        bucket_id = 'avatars'
        AND public.waves_group_from_storage_path(name) = public.waves_current_profile_id()
      );

    DROP POLICY IF EXISTS "avatars are removable by their owner" ON storage.objects;
    CREATE POLICY "avatars are removable by their owner" ON storage.objects
      FOR DELETE TO authenticated, anon
      USING (
        bucket_id = 'avatars'
        AND public.waves_group_from_storage_path(name) = public.waves_current_profile_id()
      );
  $policy$;
END
$$;

-- from 20260814140000_captures_inbox
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the captures bucket';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('captures', 'captures', false, 5242880,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "captures are readable by their owner" ON storage.objects;
    CREATE POLICY "captures are readable by their owner" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'captures'
        AND public.waves_group_from_storage_path(name) = public.waves_current_profile_id()
      );

    DROP POLICY IF EXISTS "captures are writable by their owner" ON storage.objects;
    CREATE POLICY "captures are writable by their owner" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'captures'
        AND public.waves_group_from_storage_path(name) = public.waves_current_profile_id()
      );

    DROP POLICY IF EXISTS "captures are replaceable by their owner" ON storage.objects;
    CREATE POLICY "captures are replaceable by their owner" ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'captures'
        AND public.waves_group_from_storage_path(name) = public.waves_current_profile_id()
      );

    DROP POLICY IF EXISTS "captures are removable by their owner" ON storage.objects;
    CREATE POLICY "captures are removable by their owner" ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'captures'
        AND public.waves_group_from_storage_path(name) = public.waves_current_profile_id()
      );
  $policy$;
END
$$;

-- from 20260815180000_group_photo_gate_enforcement
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping the photo policies';
    RETURN;
  END IF;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "group photos are writable by members" ON storage.objects;
    CREATE POLICY "group photos are writable by members" ON storage.objects
      FOR INSERT TO authenticated, anon
      WITH CHECK (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
        AND public.waves_can_upload_group_photo(public.waves_group_from_storage_path(name))
      );

    DROP POLICY IF EXISTS "group photos are replaceable by members" ON storage.objects;
    CREATE POLICY "group photos are replaceable by members" ON storage.objects
      FOR UPDATE TO authenticated, anon
      USING (
        bucket_id = 'group-photos'
        AND public.is_group_member(public.waves_group_from_storage_path(name))
        AND public.waves_can_upload_group_photo(public.waves_group_from_storage_path(name))
      );
  $policy$;
END
$$;

-- from 20260818150000_personal_receipt_storage
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent (plain Postgres): skipping personal receipt policies';
    RETURN;
  END IF;

  EXECUTE $policy$
    DROP POLICY IF EXISTS "personal receipts are readable by owner" ON storage.objects;
    CREATE POLICY "personal receipts are readable by owner" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
      );

    DROP POLICY IF EXISTS "personal receipts are writable by paid owner" ON storage.objects;
    CREATE POLICY "personal receipts are writable by paid owner" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
        AND public.waves_can_upload_group_photo(NULL)
      );

    DROP POLICY IF EXISTS "personal receipts are replaceable by paid owner" ON storage.objects;
    CREATE POLICY "personal receipts are replaceable by paid owner" ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
      )
      WITH CHECK (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
        AND public.waves_can_upload_group_photo(NULL)
      );

    DROP POLICY IF EXISTS "personal receipts are removable by owner" ON storage.objects;
    CREATE POLICY "personal receipts are removable by owner" ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = 'personal'
        AND (storage.foldername(name))[2] = auth.uid()::text
      );
  $policy$;
END
$$;

-- from 20260831120000_anon_surface_hardening
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
