/**
 * The date window a message import should default to: the trip.
 *
 * "Track the expenses between the dates of the travel" — so when a group knows
 * its own travel dates (`start_date`/`end_date`, set for a trip), those are the
 * window, and only payments inside it are proposed. A group with no dates falls
 * back to its own earliest expense, and a brand-new group to the last month, so
 * the field is never empty and never spans an inbox nobody meant to share.
 *
 * Pure and `now`-injected so every branch is testable without a clock.
 */

export interface TripDates {
  readonly start_date?: string | null;
  readonly end_date?: string | null;
}

export interface DatedRow {
  readonly created_at?: string | null;
}

export interface SmsDateWindow {
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;

/** An ISO-ish value trimmed to its 'YYYY-MM-DD', or null if there is nothing usable. */
function day(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 10) : null;
}

function isoDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The earliest `created_at` among a group's expenses, as 'YYYY-MM-DD'. */
function earliestExpenseDay(rows: readonly DatedRow[] | undefined): string | null {
  const days = (rows ?? [])
    .map((row) => day(row.created_at))
    .filter((value): value is string => value !== null);
  if (days.length === 0) return null;
  return days.reduce((earliest, current) => (current < earliest ? current : earliest));
}

export function smsWindowFor(
  group: TripDates | null | undefined,
  expenses: readonly DatedRow[] | undefined,
  now: Date = new Date(),
): SmsDateWindow {
  const today = isoDay(now);
  const start = day(group?.start_date);
  const end = day(group?.end_date);

  const from =
    start ?? earliestExpenseDay(expenses) ?? isoDay(new Date(now.getTime() - 30 * DAY_MS));
  const to = end ?? today;

  return { from, to };
}
