-- Receipt markup (A46): non-destructive pen/text annotations on an expense
-- image.
--
-- The bytes are never touched — a marked-up receipt is the same image plus a
-- small vector overlay (freehand strokes + text), stored here in normalised
-- (0..1) image coordinates so it renders crisp at any zoom and survives a device
-- with a different screen. Keeping it as data, not baked pixels, means the
-- markup stays editable and needs no image re-encode or re-upload, and every
-- member who can see the image sees the same notes over it.
--
-- Only a party to the expense (a payer or its author) may mark up an image — the
-- same gate as attaching one. The column rides the existing mirror (`updated_seq`
-- is bumped by the shared stamp trigger on UPDATE), so an edit propagates like
-- any other change to the row.

ALTER TABLE public.expense_attachments
  ADD COLUMN IF NOT EXISTS annotations jsonb;

-- Bound the overlay so a client cannot park megabytes of "annotation" on a row.
-- A page of strokes and a handful of text notes is a few KB; 256KB is generous.
ALTER TABLE public.expense_attachments
  DROP CONSTRAINT IF EXISTS expense_attachments_annotations_sane;
ALTER TABLE public.expense_attachments
  ADD CONSTRAINT expense_attachments_annotations_sane
  CHECK (annotations IS NULL OR pg_column_size(annotations) <= 262144);

/**
 * Set (or clear, with NULL) the markup on an attachment. A party only — the same
 * predicate that guards attaching. Soft-deleted rows are inert. The stamp trigger
 * bumps `updated_seq`, so the edit reaches every device on the next pull.
 */
CREATE OR REPLACE FUNCTION public.baaki_annotate_expense_attachment(
  p_attachment_id uuid,
  p_annotations   jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

  IF NOT public.baaki_is_expense_party(v_expense_id) THEN
    RAISE EXCEPTION 'NOT_A_PARTY: only a party may mark up this image'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.expense_attachments
     SET annotations = p_annotations
   WHERE id = p_attachment_id AND deleted_at IS NULL;
END
$$;

GRANT EXECUTE ON FUNCTION public.baaki_annotate_expense_attachment(uuid, jsonb)
  TO authenticated, anon;
