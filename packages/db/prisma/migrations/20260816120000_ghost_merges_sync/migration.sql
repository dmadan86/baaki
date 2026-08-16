-- Make ghost merges pull-syncable, so the Friends list can fold them offline.
--
-- baaki_people_i_owe folds a viewer's ghost merges (A38) server-side. To answer
-- the same question from the device with no connection (ADR-005), the merges
-- have to reach the mirror — otherwise an offline Friends read would un-fold
-- people the viewer explicitly merged, a regression. ghost_merges is created
-- only by the baaki_merge_ghosts RPC (online), so this is PULL-ONLY: the client
-- never writes it through the queue; /sync just streams it down.
--
-- Same machinery as captures (A34, 20260814140000): a per-owner counter on
-- profiles and an updated_seq the /sync pull walks with `.gt('updated_seq', N)`.
-- Stamping is a trigger, so the RPC needs no change — its INSERT ... ON CONFLICT
-- DO UPDATE fires it and re-stamps on every merge.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ghost_merges_seq BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.ghost_merges
  ADD COLUMN IF NOT EXISTS updated_seq BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ghost_merges_owner_updated_seq_idx
  ON public.ghost_merges (owner, updated_seq);

-- The per-owner high-water mark, advanced under the row lock the UPDATE takes so
-- two concurrent merges cannot mint the same seq (the ordering the pull relies
-- on). Mirror of baaki_next_capture_seq.
CREATE OR REPLACE FUNCTION public.baaki_next_ghost_merge_seq(p_owner uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

CREATE OR REPLACE FUNCTION public.baaki_stamp_ghost_merge_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_seq := public.baaki_next_ghost_merge_seq(NEW.owner);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ghost_merges_stamp_seq ON public.ghost_merges;
CREATE TRIGGER ghost_merges_stamp_seq
  BEFORE INSERT OR UPDATE ON public.ghost_merges
  FOR EACH ROW EXECUTE FUNCTION public.baaki_stamp_ghost_merge_seq();

-- Stamp rows that already exist so a first pull sees them rather than leaving
-- them behind on updated_seq = 0. The no-op UPDATE fires the trigger above.
UPDATE public.ghost_merges SET owner = owner;
