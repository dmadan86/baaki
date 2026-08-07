/**
 * A trip, day by day: what was planned, and what it actually cost.
 *
 * The reason this is worth building inside Baaki rather than reaching for an
 * itinerary app is the second half of that sentence. Anything can hold a list
 * of days with "Dudhsagar falls" on one of them. Only the app that already has
 * the ledger can say the falls were budgeted at ₹2,000 and came to ₹3,150, and
 * that the trip is ₹4,000 over four days in.
 *
 * Three rules the maths follows, all of them the same rules the ledger already
 * has:
 *
 *   * **Currencies never mix.** A day with a hotel in euros and lunch in rupees
 *     has two totals, not one made up by an exchange rate nobody agreed
 *     (ADR-003). `plannedByCurrency` and `spentByCurrency` are maps for that
 *     reason, and the screen shows each on its own line.
 *   * **Minor units and bigint throughout.** No Number touches an amount here.
 *   * **A day is a date string, never a Date.** `'2026-03-14'` compared as
 *     text. Building a `Date` to group by day is how a trip that starts on the
 *     14th shows its first expense on the 13th for everybody east of UTC — the
 *     same bug the spending chart had.
 */

import type { CurrencyCode } from '../money/currency';

/** A plan item: something somebody intends to do, and what they think it costs. */
export interface PlanItem {
  readonly id: string;
  /** `YYYY-MM-DD`, in the trip's own timezone. */
  readonly day: string;
  /** `HH:MM` or null for "sometime that day". Sorts before untimed items. */
  readonly startsAt: string | null;
  readonly title: string;
  readonly note: string | null;
  readonly category: string | null;
  /** What it was budgeted at, in minor units, or null for "no idea yet". */
  readonly plannedMinor: bigint | null;
  readonly currency: CurrencyCode;
  /** Ticked off. A plan item is done when somebody says it is, not when it is paid. */
  readonly done: boolean;
  /** The expense that turned out to be this, once somebody links them. */
  readonly expenseId: string | null;
  readonly position: number;
}

/** An expense, reduced to what a timeline needs of it. */
export interface TimelineExpense {
  readonly id: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly description: string;
  readonly category: string | null;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export interface TimelineDay {
  readonly day: string;
  readonly items: readonly PlanItem[];
  readonly expenses: readonly TimelineExpense[];
  readonly plannedByCurrency: Readonly<Record<string, bigint>>;
  readonly spentByCurrency: Readonly<Record<string, bigint>>;
}

export interface Timeline {
  readonly days: readonly TimelineDay[];
  readonly plannedByCurrency: Readonly<Record<string, bigint>>;
  readonly spentByCurrency: Readonly<Record<string, bigint>>;
}

/** `'2026-03-14'` + n days, as text. No Date, no timezone, no drift. */
export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number);
  // UTC deliberately: this is date arithmetic on a label, not a moment in time.
  const moment = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + count));
  return moment.toISOString().slice(0, 10);
}

/** Every day from start to end inclusive, or an empty list if the range is nonsense. */
export function daysBetween(start: string, end: string, limit = 400): string[] {
  if (!start || !end || end < start) return [];
  const days: string[] = [];
  let day = start;
  while (day <= end && days.length < limit) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

function add(into: Record<string, bigint>, currency: string, amount: bigint): void {
  into[currency] = (into[currency] ?? 0n) + amount;
}

/**
 * Merge a plan and a ledger into one list of days.
 *
 * Days come from the trip's own dates when it has them, so an empty Tuesday in
 * the middle still appears — a planner that hides the days with nothing on them
 * is a planner nobody can plan *into*. Anything dated outside that range still
 * shows up rather than being dropped: an expense on the way home is a real
 * expense, and silently omitting it would make the totals disagree with the
 * group's own balances.
 */
export function buildTimeline(input: {
  readonly items: readonly PlanItem[];
  readonly expenses: readonly TimelineExpense[];
  /** The trip's dates, if it has any. */
  readonly startDate?: string | null;
  readonly endDate?: string | null;
}): Timeline {
  const dayKeys = new Set<string>();

  if (input.startDate && input.endDate) {
    for (const day of daysBetween(input.startDate, input.endDate)) dayKeys.add(day);
  }
  for (const item of input.items) dayKeys.add(item.day);
  for (const expense of input.expenses) dayKeys.add(expense.date);

  const plannedTotal: Record<string, bigint> = {};
  const spentTotal: Record<string, bigint> = {};

  const days = [...dayKeys]
    .sort()
    .map((day) => {
      const items = input.items
        .filter((item) => item.day === day)
        .sort(
          (a, b) =>
            // Timed things first and in order; then whatever order somebody
            // dragged them into. Two untimed items keep their position rather
            // than shuffling on every render.
            Number(a.startsAt === null) - Number(b.startsAt === null) ||
            (a.startsAt ?? '').localeCompare(b.startsAt ?? '') ||
            a.position - b.position ||
            a.id.localeCompare(b.id),
        );

      const expenses = input.expenses
        .filter((expense) => expense.date === day)
        .sort((a, b) => a.description.localeCompare(b.description) || a.id.localeCompare(b.id));

      const planned: Record<string, bigint> = {};
      const spent: Record<string, bigint> = {};

      for (const item of items) {
        if (item.plannedMinor === null) continue;
        add(planned, item.currency, item.plannedMinor);
        add(plannedTotal, item.currency, item.plannedMinor);
      }
      for (const expense of expenses) {
        add(spent, expense.currency, expense.amountMinor);
        add(spentTotal, expense.currency, expense.amountMinor);
      }

      return { day, items, expenses, plannedByCurrency: planned, spentByCurrency: spent };
    });

  return { days, plannedByCurrency: plannedTotal, spentByCurrency: spentTotal };
}

/**
 * Planned against actual, per currency.
 *
 * Positive is over budget, because that is the number somebody is looking for.
 * A currency that was planned and never spent, or spent and never planned,
 * appears in both maps — leaving one out would make a trip look on budget
 * because nobody budgeted.
 */
export function budgetVariance(timeline: {
  readonly plannedByCurrency: Readonly<Record<string, bigint>>;
  readonly spentByCurrency: Readonly<Record<string, bigint>>;
}): Record<string, bigint> {
  const variance: Record<string, bigint> = {};
  for (const currency of new Set([
    ...Object.keys(timeline.plannedByCurrency),
    ...Object.keys(timeline.spentByCurrency),
  ])) {
    variance[currency] =
      (timeline.spentByCurrency[currency] ?? 0n) - (timeline.plannedByCurrency[currency] ?? 0n);
  }
  return variance;
}

/**
 * Which day a trip is on, or null when it is not running.
 *
 * `today` is passed in rather than read from the clock: the answer depends on
 * the trip's timezone, and this package has no business knowing what time it is
 * in Goa.
 */
export function dayNumber(
  today: string,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): number | null {
  if (!startDate || !endDate) return null;
  if (today < startDate || today > endDate) return null;
  return daysBetween(startDate, today).length;
}
