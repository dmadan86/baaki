-- A per-group ceiling on receipts, set from the admin console (ADR-011 / A16).
--
-- Every group gets a number of receipts for free; past it, somebody has to pay
-- or bring their own storage. Unlike the group-photo gate — a plain boolean
-- entitlement — the receipt cap has a *number*, and that number must be a knob
-- the console can turn without a deploy. `feature_flags` cannot hold it: a flag
-- answers on/off and which A/B arm, never "how many", and the server could not
-- read a limit out of an arm name cleanly.
--
-- So a second, deliberately tiny configuration table: `app_config`, one row per
-- numeric knob. Same shape of trust as `feature_flags` — readable by any client
-- (it is configuration, not data about a person), written by the service role
-- alone. A limit a client could raise is not a limit.
--
-- The cap lifts entirely for a paid group, exactly like the photo gate: one
-- member's subscription (or an unexpired group pass) frees the whole group.

-- ─────────────────────────────────────────────────── the knob ──

CREATE TABLE IF NOT EXISTS public.app_config (
  key         text PRIMARY KEY,
  value       integer NOT NULL,
  description text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Same identifier shape as a flag key, for the same reason: it is read from
  -- code by name, and a key differing only by case is a bug nobody finds.
  CONSTRAINT app_config_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  -- A negative ceiling is never intended; zero means "paid only".
  CONSTRAINT app_config_value_nonneg CHECK (value >= 0)
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

-- Readable by everybody signed in, guests included — the phone needs the number
-- to draw the right affordance before it ever tries to scan, and offline
-- (ADR-005). Nothing here is secret.
DROP POLICY IF EXISTS app_config_read ON public.app_config;
CREATE POLICY app_config_read ON public.app_config
  FOR SELECT TO anon, authenticated USING (true);

-- No write policy, so with RLS on only the service role can change a limit.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.app_config FROM anon, authenticated;

-- The default ceiling. `ON CONFLICT DO NOTHING` so re-running the migration
-- never stamps over a number the console has since changed.
INSERT INTO public.app_config (key, value, description)
VALUES ('receipt_cap_per_group', 3, 'Free receipts a group may hold before it must upgrade or add storage.')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────── reading the knob ──

/**
 * The receipt ceiling, with a floor to fall back to.
 *
 * If the row is missing — a project the seed never reached — a sensible default
 * rather than zero, so a misconfiguration is generous, not a lockout.
 */
CREATE OR REPLACE FUNCTION public.baaki_receipt_cap()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT value FROM public.app_config WHERE key = 'receipt_cap_per_group'), 3);
$$;

GRANT EXECUTE ON FUNCTION public.baaki_receipt_cap() TO authenticated, anon, service_role;

-- ────────────────────────────────────── is the group paid ──

/**
 * Whether a group is paid: any current member holds an active subscription, or
 * the group itself has an unexpired pass. The same rule the photo gate uses,
 * pulled into one function because both the client gate and the record path
 * ask it. SECURITY DEFINER because a member cannot read another member's
 * subscription under RLS; the answer is a bare boolean and reveals nothing
 * about whose it was.
 */
CREATE OR REPLACE FUNCTION public.baaki_group_is_paid(p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.left_at IS NULL
       AND gm.profile_id IS NOT NULL
       AND public.baaki_profile_is_paid(gm.profile_id)
  ) OR EXISTS (
    SELECT 1 FROM public.group_passes gp
     WHERE gp.group_id = p_group_id
       AND gp.expires_at > now()
  );
$$;

REVOKE ALL ON FUNCTION public.baaki_group_is_paid(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_group_is_paid(uuid) TO authenticated, service_role;

-- ─────────────────────────────── may the caller add a receipt ──

/**
 * May the caller attach one more receipt to this group?
 *   * not a member  → no (and it is not their business how many the group has);
 *   * paid group    → always yes, the cap does not apply;
 *   * otherwise     → yes while the group holds fewer than the cap.
 *
 * A bare boolean, like the photo gate. The client uses it to choose the scan
 * button or the upsell; `baaki_record_receipt` enforces the same rule as the
 * real boundary, so a client that ignores this answer still cannot exceed it.
 */
CREATE OR REPLACE FUNCTION public.baaki_can_add_receipt(p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile uuid := public.baaki_current_profile_id();
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

  IF public.baaki_group_is_paid(p_group_id) THEN
    RETURN true;
  END IF;

  RETURN (SELECT count(*) FROM public.receipts WHERE group_id = p_group_id)
         < public.baaki_receipt_cap();
END
$$;

REVOKE ALL ON FUNCTION public.baaki_can_add_receipt(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_can_add_receipt(uuid) TO authenticated;

-- ──────────────────────── the cap as the real boundary ──
-- `baaki_record_receipt` is the single service-role path that writes a receipt
-- row (ADR-013), so the ceiling is enforced here where it cannot be bypassed.
-- Re-declared whole (CREATE OR REPLACE) with the cap check added; the body is
-- otherwise the 20260805140000 original.
--
-- Only a *new* row is capped. Re-recording an existing receipt id (a re-parse
-- of the same bill) is an UPDATE and must always be let through, or a retry
-- after the cap is reached would fail on a receipt that already counts.

CREATE OR REPLACE FUNCTION public.baaki_record_receipt(
  p_group_id     uuid,
  p_receipt_id   uuid,
  p_profile_id   uuid,
  p_source       text,
  p_storage_path text,
  p_raw_text     text,
  p_parsed       jsonb,
  p_status       text,
  p_input_tokens int DEFAULT 0,
  p_output_tokens int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- The ceiling, enforced at the one insert path. A paid group is exempt; an
  -- update of a receipt that already exists is not a new receipt and is exempt.
  IF NOT public.baaki_group_is_paid(p_group_id)
     AND (p_receipt_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.receipts WHERE id = p_receipt_id))
     AND (SELECT count(*) FROM public.receipts WHERE group_id = p_group_id)
         >= public.baaki_receipt_cap()
  THEN
    RAISE EXCEPTION 'RECEIPT_CAP'
      USING ERRCODE = 'check_violation',
            HINT = 'This group has reached its receipt limit; upgrade or add storage to add more.';
  END IF;

  INSERT INTO public.receipts
    (id, group_id, storage_path, source, raw_text, parse_status, parsed, created_by)
  VALUES
    (COALESCE(p_receipt_id, gen_random_uuid()), p_group_id, p_storage_path,
     p_source::"ReceiptSource", p_raw_text, p_status::"ParseStatus", p_parsed,
     public.baaki_my_member_id_for(p_group_id, p_profile_id))
  ON CONFLICT (id) DO UPDATE
    SET parsed = excluded.parsed,
        parse_status = excluded.parse_status,
        raw_text = excluded.raw_text
  RETURNING id INTO v_id;

  -- Metered because each scan has a real API cost to watch (ADR-011).
  INSERT INTO public.usage_events
    (profile_id, group_id, kind, input_tokens, output_tokens, metadata)
  VALUES (p_profile_id, p_group_id, 'receipt_scan', p_input_tokens, p_output_tokens,
          jsonb_build_object('receiptId', v_id, 'status', p_status));

  RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION public.baaki_record_receipt(
  uuid, uuid, uuid, text, text, text, jsonb, text, int, int
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baaki_record_receipt(
  uuid, uuid, uuid, text, text, text, jsonb, text, int, int
) TO service_role;
