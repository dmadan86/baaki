-- Inviting somebody by email or phone (ADR-006).
--
-- A ghost member can now carry the address the invite should go to. This is a
-- *hint attached to one person you are inviting*, not a contact book: nothing
-- here stores, uploads or matches against the phone's address book, and there
-- is deliberately no way to ask this schema "which of these emails already use
-- Baaki". That question is the one every contacts feature answers by accident,
-- and answering it turns an address book into a membership oracle.
--
-- Normalisation is enforced here rather than trusted from the client, because
-- the same person typed two ways must not become two ghosts:
--   asha@Example.COM and asha@example.com are one address;
--   +91 98765 43210, 09876543210 and +919876543210 are one number.
-- The client cannot be relied on for that — the offline queue means an old
-- build's idea of normalisation can arrive months late (ADR-005).

ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS invite_email text,
  ADD COLUMN IF NOT EXISTS invite_phone text;

COMMENT ON COLUMN public.group_members.invite_email IS
  'Where to send this person''s invite. Lowercased. Visible to the group.';
COMMENT ON COLUMN public.group_members.invite_phone IS
  'E.164 only, e.g. +919876543210. Visible to the group.';

-- Stored E.164 or not at all. A local-format number is the same person as its
-- international form, and keeping both would split one human into two members
-- holding two halves of a balance.
ALTER TABLE public.group_members
  DROP CONSTRAINT IF EXISTS group_members_invite_phone_e164;
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_invite_phone_e164
  CHECK (invite_phone IS NULL OR invite_phone ~ '^\+[1-9][0-9]{7,14}$');

-- Not a full RFC 5322 validation, which is famously not worth attempting in a
-- CHECK. This rejects the mistakes that matter: whitespace, a missing @, an
-- uppercase address that would duplicate a lowercase one.
ALTER TABLE public.group_members
  DROP CONSTRAINT IF EXISTS group_members_invite_email_shape;
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_invite_email_shape
  CHECK (invite_email IS NULL OR invite_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');

ALTER TABLE public.group_members
  DROP CONSTRAINT IF EXISTS group_members_invite_email_lowercase;
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_invite_email_lowercase
  CHECK (invite_email IS NULL OR invite_email = lower(invite_email));


-- ───────────────────────────────────────── adding somebody by contact ──
-- `baaki_add_ghost_member` already existed as (uuid, text, uuid) — the third
-- argument is the client-chosen member id that makes a replayed offline
-- mutation idempotent (ADR-005). Contact details are added to THAT function
-- rather than declared as a new one.
--
-- The overload trap, for the fourth time in this project: CREATE OR REPLACE
-- with a different argument count creates a SECOND function. Here it was worse
-- than ambiguity — a 3-argument call `(group, name, member_uuid)` silently
-- resolved to a new `(group, name, email)` and tried to store a uuid as an
-- email address. The M2 suite caught it. Adding parameters to an existing
-- function means editing its real signature, never writing a fresh one.

DROP FUNCTION IF EXISTS public.baaki_add_ghost_member(uuid, text, uuid);

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

  RETURN v_member_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_add_ghost_member(uuid, text, uuid, text, text)
  TO authenticated, anon;
