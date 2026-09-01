/**
 * Ordering ISO-8601 timestamps.
 *
 * Every feed in the app sorts by `created_at`, and every one of them reached
 * for `String(b.created_at).localeCompare(String(a.created_at))`. That is a
 * *collation* — it asks Intl how the user's language orders text, loads a
 * collator, and applies locale rules to a string that is not language at all.
 * On a fixed-format UTC timestamp the answer is always the same as a plain
 * byte comparison, for about nine times the cost on V8 and considerably worse
 * under Hermes.
 *
 * It matters because these sorts are not cold. The mirror re-materialises on
 * every sync tick, and each pass re-sorts the group's expenses, its settlements
 * and its whole activity log — so the collator ran thousands of times a second
 * on a screen that was doing nothing but sitting there.
 *
 * The comparison is safe on exactly what the ledger stores: `YYYY-MM-DDTHH…Z`
 * and `YYYY-MM-DD`, both fixed-width, zero-padded and UTC, which makes
 * lexicographic order and chronological order the same order. It is *not* safe
 * on mixed offsets ("+05:30" against "Z"), and nothing in the schema writes
 * those — timestamps come back from Postgres normalised.
 *
 * Null and undefined sort last in both directions: a row with no timestamp is
 * missing data, not the oldest thing that ever happened.
 */

type Stamp = string | null | undefined;

/** A stamp that actually says something — not absent, and not the empty string
 *  a nullable column turns into on the way through `String(...)`. Written as a
 *  type predicate so the comparisons below narrow to `string`. */
function present(stamp: Stamp): stamp is string {
  return stamp != null && stamp !== '';
}

/**
 * Ascending: oldest first, with the stamps that say nothing at the end.
 *
 * The missing check comes first and is direction-independent on purpose.
 * Reversing an ordinary comparator by swapping its arguments also reverses
 * where it puts the blanks, which is how "missing sorts last" silently becomes
 * "missing sorts first" in one of the two directions.
 */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (!present(a)) return present(b) ? 1 : 0;
  if (!present(b)) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Descending: newest first, and still with the blanks at the end. */
export function compareStampsDesc(a: Stamp, b: Stamp): number {
  if (!present(a)) return present(b) ? 1 : 0;
  if (!present(b)) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

/** Newest first — the order every feed in the app reads in. */
export function byNewest<T>(stampOf: (row: T) => Stamp): (a: T, b: T) => number {
  return (a, b) => compareStampsDesc(stampOf(a), stampOf(b));
}

/** Oldest first — settlement allocation, and anything replayed in order. */
export function byOldest<T>(stampOf: (row: T) => Stamp): (a: T, b: T) => number {
  return (a, b) => compareStamps(stampOf(a), stampOf(b));
}
