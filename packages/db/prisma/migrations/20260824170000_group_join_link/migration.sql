-- A durable, reusable group join link (the WhatsApp/Signal/Telegram model).
--
-- Today's invites are one-time-reveal: the raw token is returned once by
-- invite-mint and only its SHA-256 hash is stored, so a link can never be shown
-- again. That is right for a "share a limited invite" flow, but it means the QR
-- screen had to mint a fresh link every visit. The industry pattern is a single
-- stable link per group, shown instantly and re-showable, with a Reset to rotate
-- it if it leaks.
--
-- So the group keeps ONE durable invite whose raw token is stored on the group
-- (`groups.join_token`) — re-showable — while an ordinary `invites` row carries
-- its hash with a 100-year expiry and an effectively unlimited use count. That
-- means the entire existing preview / accept / ghost-claim / device-cap / guest
-- pipeline works on the durable link UNCHANGED (invite-accept just hashes the
-- token it receives and looks it up). Nothing new joins; only the link's
-- lifecycle is new. `join_token` rides the normal `select('*')` group pull, so
-- the QR paints from the mirror with no server round-trip once it exists.
--
-- The token is a bearer credential, but it reaches only group members: the group
-- row is RLS-scoped, so a non-member never receives `join_token`. Members can
-- already mint invites, so this widens nothing. Resetting is admin-only.

-- SHA-256 must match the edge's (plain sha256, no secret), so we need pgcrypto's
-- digest. On Supabase it already lives in the `extensions` schema; create that
-- schema + extension so a bare Postgres (the test DB) has it in the same place,
-- and qualify every call `extensions.*` so the resolution is identical in both.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS join_token text;

-- Pin join_token against a direct client write: only the SECURITY DEFINER RPCs
-- below (which run as the owner and so skip this guard) may set it. Otherwise a
-- member could PATCH it to garbage and break the group's QR. This re-declares
-- the guard from 20260824130000 with one added clause.
CREATE OR REPLACE FUNCTION public.baaki_guard_group_columns()
RETURNS trigger
LANGUAGE plpgsql
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
     AND NOT public.baaki_can_upload_group_photo(NEW.id) THEN
    RAISE EXCEPTION 'PHOTO_GATE: a group photo is a paid feature'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.category_budgets IS DISTINCT FROM OLD.category_budgets THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: category budgets are set through baaki_set_category_budget, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.join_token IS DISTINCT FROM OLD.join_token THEN
    RAISE EXCEPTION 'FORBIDDEN_COLUMN: the join link is set through baaki_ensure_group_join_token / baaki_reset_group_join_token, not a direct write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

-- ────────────────────────────────────────────────────────── the durable link ──

/**
 * A fresh durable invite for a group: a random raw token, its hash in `invites`
 * with a 100-year life and an effectively unlimited use count, and the raw token
 * on the group so it can be re-shown. Internal — the two entry points below call
 * it. `p_revoke_existing` retires the group's current durable link first (reset);
 * ensure leaves other live links alone.
 */
CREATE OR REPLACE FUNCTION public.baaki_new_group_join_token(
  p_group_id uuid,
  p_revoke_existing boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
    public.baaki_current_profile_id(),
    now() + interval '100 years',
    1000000
  );

  UPDATE public.groups SET join_token = v_token WHERE id = p_group_id;
  RETURN v_token;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_new_group_join_token(uuid, boolean) FROM public, anon, authenticated;

/**
 * The group's durable join token, making one on first use. Any member may fetch
 * it — a shared link is a member-level convenience, not an admin one, matching
 * who can mint an invite today. Returns the same token on every call while the
 * durable link is still live, so the QR is stable across opens and devices.
 */
CREATE OR REPLACE FUNCTION public.baaki_ensure_group_join_token(p_group_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

  RETURN public.baaki_new_group_join_token(p_group_id, false);
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_ensure_group_join_token(uuid) TO authenticated, anon;

/**
 * Rotate the durable link: revoke the current one (its QR and every copy of it
 * stop working) and mint a fresh one. Admin-only — one member should not be able
 * to invalidate the link the whole group has been sharing.
 */
CREATE OR REPLACE FUNCTION public.baaki_reset_group_join_token(p_group_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'ADMIN_ONLY: only an admin can reset the join link'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN public.baaki_new_group_join_token(p_group_id, true);
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_reset_group_join_token(uuid) TO authenticated, anon;
