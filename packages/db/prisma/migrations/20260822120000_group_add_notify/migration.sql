-- Tap the people who are already on Waves when they are added to a group.
--
-- The clone-a-group flow (and, now, adding a contact to any group) can add
-- somebody by their email or number. If that address belongs to an existing
-- account, they should hear about it the same way they hear about an expense —
-- a push and an inbox line — instead of finding the group only if they happen
-- to open the app. TDR §7.1 amendment: a new notification kind `group_added`.
--
-- This is the only change: `baaki_add_ghost_member` gains a notification write
-- after a *genuine* insert. The two idempotent paths above the insert (a
-- replayed member id, a same-contact match) RETURN before they reach it, so a
-- retried offline mutation or a double-tap never buzzes anyone twice — and the
-- per-(group, person) dedupe key on `notifications` is the second belt.
--
-- Who is notified: an `auth.users` row whose email or phone equals the address
-- the ghost was added with, that is not the caller, and that is not already an
-- active member of this group (they are in already — no need to tap them). A
-- ghost has no account yet, so a plain ghost add stays silent, which is exactly
-- ADR-006's "people who have not installed anything are still participants".

CREATE OR REPLACE FUNCTION public.baaki_add_ghost_member(
  p_group_id  uuid,
  p_name      text,
  p_member_id uuid DEFAULT NULL,
  p_email     text DEFAULT NULL,
  p_phone     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_id uuid := public.baaki_current_profile_id();
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

      PERFORM public.baaki_notify(
        v_target,
        p_group_id,
        'group_added',
        -- English fallback only; every current build re-renders from kind +
        -- payload in the reader's own language (see render.ts). `counterparty`
        -- is the fact `{actor}` reads from; `group` is `{group}`.
        coalesce(v_actor_name, 'Someone') || ' added you to ' || coalesce(v_group_name, 'a group'),
        'Tap to open the group',
        'baaki://group/' || p_group_id::text,
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

GRANT EXECUTE ON FUNCTION public.baaki_add_ghost_member(uuid, text, uuid, text, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
