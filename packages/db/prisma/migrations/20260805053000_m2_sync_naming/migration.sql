-- Follow-up to 20260805050000_m2_offline_sync, kept separate because that
-- migration had already been applied and editing an applied migration breaks
-- its checksum for every other environment.
--
-- Nothing here changes behaviour. It aligns the hand-written SQL with the names
-- and referential actions Prisma generates, so `prisma migrate diff` reports a
-- clean schema and the drift check keeps its value (TDR §2.0). Found by that
-- check, which is exactly what it is for.

ALTER INDEX public.expenses_group_seq_idx RENAME TO expenses_group_id_updated_seq_idx;
ALTER INDEX public.group_members_group_seq_idx RENAME TO group_members_group_id_updated_seq_idx;
ALTER INDEX public.settlements_group_seq_idx RENAME TO settlements_group_id_updated_seq_idx;
ALTER INDEX public.activity_log_group_seq_idx RENAME TO activity_log_group_id_updated_seq_idx;

-- Prisma's default for a relation scalar is ON UPDATE CASCADE; a plain
-- REFERENCES leaves it NO ACTION. Primary keys here are never updated, so this
-- is a naming-parity change rather than a functional one.
ALTER TABLE public.sync_mutations
  DROP CONSTRAINT sync_mutations_profile_id_fkey,
  DROP CONSTRAINT sync_mutations_group_id_fkey;

ALTER TABLE public.sync_mutations
  ADD CONSTRAINT sync_mutations_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES public.profiles(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT sync_mutations_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES public.groups(id)
    ON DELETE CASCADE ON UPDATE CASCADE;
