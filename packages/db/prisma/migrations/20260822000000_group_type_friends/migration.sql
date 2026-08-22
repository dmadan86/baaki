-- Add a "friends" kind of group alongside trip/home/couple/event/other.
--
-- Additive and idempotent: ALTER TYPE ... ADD VALUE only extends the enum, so
-- existing rows and the create RPC (which casts its text p_type to "GroupType"
-- on insert) keep working unchanged. IF NOT EXISTS makes a re-run a no-op.
-- Postgres keeps enum values for good; there is nothing to roll back, and an
-- unused value costs nothing.
ALTER TYPE "GroupType" ADD VALUE IF NOT EXISTS 'friends' AFTER 'event';
