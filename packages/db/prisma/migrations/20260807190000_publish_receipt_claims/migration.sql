-- The claims nobody could see arrive.
--
-- `useItemClaims` subscribes to `receipt_item_claims` so four people round a
-- table watch each other's taps appear. It subscribed to a table Postgres was
-- not publishing: `supabase_realtime` was given its list in M1 and nothing has
-- added to it since, so every claim written after that landed in the database
-- and reached nobody.
--
-- Found by running two phones against one bill. One claimed a line, the row was
-- there a second later with revision 1, and the other phone went on saying
-- "nobody has claimed this" — which no test in this repo could have caught,
-- because every one of them reads the table directly.
--
-- `receipts` joins it for the same reason one step earlier: publishing the
-- lines is what turns a private list into a shared one, and the other phone
-- should not have to be told to pull down and refresh to find out.

DO $$
DECLARE
  v_table text;
BEGIN
  -- Guarded: CI runs against plain Postgres, which has no `supabase_realtime`.
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY ARRAY['receipt_item_claims', 'receipts', 'trip_plan_items']
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- A claim is resolved by its revision, so a subscriber that receives only the
-- changed columns cannot tell which of two updates is newer. REPLICA IDENTITY
-- FULL sends the whole row, which is what the other tables in this publication
-- already do and what the CRDT needs.
ALTER TABLE public.receipt_item_claims REPLICA IDENTITY FULL;
