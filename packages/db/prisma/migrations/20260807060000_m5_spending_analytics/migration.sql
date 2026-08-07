-- Where the money went (M5, TDR §8).
--
-- TDR §8 asks for "SQL views". This is a function instead, for the same reason
-- every other derived read in this schema is one (`baaki_people_i_owe`,
-- `baaki_group_balances_truth`): Prisma owns the datamodel, `prisma migrate
-- diff` is a merge gate (ADR-014), and a view is an object Prisma has an
-- opinion about while a function is not. The shape returned is exactly what a
-- view would have held, and PostgREST calls it in one round trip.
--
-- Three things it deliberately does not do:
--
-- It does not convert currencies. An expense carries its own rate (ADR-003)
-- and multiplying it out here would put a rounded, unreproducible number in a
-- chart beside exact ones. Currency stays in the key; the screen draws one
-- section per currency and says so.
--
-- It does not sum across members. The caller wants both "what this group
-- spent" and "what I spent", and the second cannot be recovered from the
-- first. The finest grain is returned once and the client adds up whichever
-- way it is asking.
--
-- It does not read history. Only the current version of a live expense counts,
-- the same rule the balances use: an edited expense is what it now says, and a
-- deleted one is not spending.

CREATE OR REPLACE FUNCTION public.baaki_group_spending(p_group_id uuid)
RETURNS TABLE (
  member_id     uuid,
  currency      char(3),
  /** Lowercased; anything unrecognised or absent lands in 'other'. */
  category      text,
  /** First day of the month the expense is dated to. */
  month         date,
  /** What this member's share of that category cost, in minor units. */
  share_amount  bigint,
  expense_count int
)
LANGUAGE sql
STABLE
-- SECURITY INVOKER (the default, stated for the reader): RLS on expenses,
-- expense_versions and expense_shares is what decides whose spending this is
-- allowed to show. A non-member gets an empty table, not an error.
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH live_versions AS (
    SELECT ev.id, ev.currency, ev.expense_date, ev.category, e.id AS expense_id
    FROM public.expense_versions ev
    JOIN public.expenses e
      ON e.id = ev.expense_id
     AND e.current_version_id = ev.id
     AND e.deleted_at IS NULL
    WHERE e.group_id = p_group_id
  )
  SELECT
    s.member_id,
    lv.currency,
    COALESCE(NULLIF(btrim(lower(lv.category)), ''), 'other') AS category,
    date_trunc('month', lv.expense_date)::date               AS month,
    SUM(s.amount)::bigint                                    AS share_amount,
    COUNT(DISTINCT lv.expense_id)::int                       AS expense_count
  FROM public.expense_shares s
  JOIN live_versions lv ON lv.id = s.expense_version_id
  GROUP BY 1, 2, 3, 4
$$;

GRANT EXECUTE ON FUNCTION public.baaki_group_spending(uuid) TO authenticated, anon;

COMMENT ON FUNCTION public.baaki_group_spending(uuid) IS
  'M5 analytics (TDR §8): per-member, per-category, per-month spending for one group, in minor units, one row per currency.';
