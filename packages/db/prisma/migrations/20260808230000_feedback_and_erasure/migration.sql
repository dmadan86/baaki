-- Two things people should be able to do: say something, and leave.
--
-- ─────────────────────────────────────────────────────────── leaving ──
--
-- Deleting a person from a shared ledger is not a delete. Asha's expenses are
-- also Ravi's records: they are what says he owes ₹4,500, and removing them
-- would silently change *his* balance to settle a request that was never his.
-- ADR-004 makes the ledger append-only for exactly this reason.
--
-- The database already refuses to pretend otherwise. `group_members.profile_id`
-- is ON DELETE SET NULL, and the table also carries
-- `CHECK ((profile_id IS NULL) <> (ghost_name IS NULL))`, so deleting a profile
-- that is in any group raises `group_members_profile_xor_ghost`. That is not an
-- obstacle to work around; it is the schema saying that a membership cannot
-- stop referring to somebody without becoming a reference to somebody else.
--
-- So erasure converts the person into a **ghost member** — the shape ADR-006
-- already uses for people who never joined. Every balance, share and settlement
-- survives untouched and every other member's ledger stays exactly as true as
-- it was. What goes is the person: name, avatar, payment handles, country,
-- locale, notification preferences, push tokens, and the auth identity behind
-- them. What remains is an unnamed participant, which is the least that can
-- remain without falsifying somebody else's money.
--
-- This is the reading DPDP §12 and GDPR Art 17(3) both allow: erasure yields
-- where it would erase a third party's rights. The app says so plainly on the
-- screen before anybody confirms, rather than promising a delete it cannot do.
--
-- ────────────────────────────────────────────────────────── saying so ──
--
-- Feedback outlives the account that gave it, by `ON DELETE SET NULL` rather
-- than CASCADE. The most valuable thing anybody writes is why they are leaving,
-- and cascading it away at the moment of deletion would destroy precisely that.

-- ───────────────────────────────────────────────────────────── feedback ──

CREATE TABLE IF NOT EXISTS public.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable and SET NULL on purpose: see above.
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL ON UPDATE CASCADE,
  kind text NOT NULL DEFAULT 'general',
  message text NOT NULL,
  -- 1–5 where somebody offered one. NULL means they wrote without rating.
  rating integer,
  -- Context worth having when reading a complaint, none of it identifying.
  app_version text,
  platform text,
  locale text,
  country_code text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feedback_kind_known CHECK (kind IN ('general', 'bug', 'idea', 'deletion')),
  CONSTRAINT feedback_message_present CHECK (length(trim(message)) BETWEEN 1 AND 4000),
  CONSTRAINT feedback_rating_range CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS feedback_recent_idx ON public.feedback (created_at DESC);

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

-- Somebody may read back what they wrote. Nobody may read anybody else's, and
-- no client writes directly — `baaki_submit_feedback` stamps the author, so a
-- client cannot file a complaint under another person's name.
DROP POLICY IF EXISTS feedback_own ON public.feedback;
CREATE POLICY feedback_own ON public.feedback
  FOR SELECT TO authenticated
  USING (profile_id = public.baaki_current_profile_id());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.feedback FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.baaki_submit_feedback(
  p_message text,
  p_kind text DEFAULT 'general',
  p_rating integer DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_platform text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
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

-- ────────────────────────────────────────────────────────────── erasure ──

/**
 * What deleting would do, before anybody agrees to it.
 *
 * The screen shows these numbers so the decision is made with them in view: a
 * person is entitled to know that their name leaves and their share of a
 * dinner does not.
 */
CREATE OR REPLACE FUNCTION public.baaki_my_erasure_preview()
RETURNS TABLE (
  groups_count bigint,
  expenses_authored bigint,
  settlements_involved bigint,
  outstanding_currencies text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH me AS (
    SELECT id FROM public.group_members
     WHERE profile_id = public.baaki_current_profile_id()
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

/**
 * Erase the person, keep the ledger.
 *
 * Order matters. The feedback is written first, while the profile still exists
 * to be referenced — after the delete it survives with a NULL author, which is
 * the point. Then every membership becomes a ghost in one statement, because
 * the XOR constraint means profile_id and ghost_name have to change together.
 * Only then can the profile row go, taking the personal tables with it by
 * cascade: push tokens, notifications, subscriptions, usage, redemptions,
 * impressions, sync queue.
 *
 * The auth identity is NOT deleted here. It lives in a schema this database
 * role does not own, and removing it needs the admin API — the `account-delete`
 * edge function calls this and then does that. A caller that stops here has
 * erased the data and left an account that can sign in to nothing, which is
 * recoverable; the reverse would not be.
 */
CREATE OR REPLACE FUNCTION public.baaki_delete_my_account(p_feedback text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
  v_memberships integer;
BEGIN
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN';
  END IF;

  -- While there is still an author to attribute it to. It outlives the row.
  IF length(trim(COALESCE(p_feedback, ''))) > 0 THEN
    PERFORM public.baaki_submit_feedback(p_feedback, 'deletion');
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

-- ────────────────────────────────────────────── what the console reads ──

/**
 * Feedback, newest first.
 *
 * The message is what somebody chose to write, so it is shown; the author is
 * not, because knowing who complained is not needed to act on a complaint. A
 * NULL author is somebody who has since deleted their account — their words
 * remain, which is the reason the foreign key is SET NULL.
 */
CREATE OR REPLACE FUNCTION public.baaki_admin_feedback(p_limit integer DEFAULT 100)
RETURNS TABLE (
  id uuid,
  kind text,
  message text,
  rating integer,
  app_version text,
  platform text,
  locale text,
  country_code text,
  from_deleted_account boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    f.id, f.kind, f.message, f.rating, f.app_version, f.platform,
    f.locale, f.country_code, f.profile_id IS NULL, f.created_at
  FROM public.feedback f
  ORDER BY f.created_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 100), 1);
$$;

-- ─────────────────────────────────────────────────────────────── grants ──

REVOKE ALL ON FUNCTION public.baaki_submit_feedback(text, text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_submit_feedback(text, text, integer, text, text)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.baaki_my_erasure_preview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_my_erasure_preview() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.baaki_delete_my_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baaki_delete_my_account(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.baaki_admin_feedback(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baaki_admin_feedback(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_admin_feedback(integer) TO service_role;
