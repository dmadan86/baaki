-- Adjust a receipt image (A46): rotate / crop replaces the stored bytes.
--
-- Rotate and crop bake new pixels (unlike the pen/text overlay, which is data on
-- the row). The new image goes to a fresh key in the same expense-scoped folder,
-- then this RPC repoints the row at it. Because the pixels changed, any markup
-- drawn over the old image no longer lines up, so the replace clears it — a
-- correction, not a silent drift.
--
-- Party-only, the same gate as attaching or marking up. The stamp trigger bumps
-- `updated_seq`, so the swap reaches every device on the next pull, and the
-- client frees the old object best-effort once the row points at the new one.

CREATE OR REPLACE FUNCTION public.baaki_replace_expense_attachment_image(
  p_attachment_id uuid,
  p_new_path      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

  IF NOT public.baaki_is_expense_party(v_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may adjust this image'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_attachments
     SET storage_path = btrim(p_new_path),
         annotations  = NULL
   WHERE id = p_attachment_id AND deleted_at IS NULL;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_replace_expense_attachment_image(uuid, text)
  TO authenticated, anon;
