/**
 * Burn-rate forecast: at this pace, where does the trip land?
 *
 * "You've spent ₹28,000 in three days of a seven-day trip; on this pace it ends
 * around ₹65,000 — ₹5,000 over the budget." A projection, not a promise: it
 * assumes tomorrow looks like the days so far, which is exactly the assumption a
 * traveller is testing when they ask.
 *
 * The rules, unchanged from the rest of the trip maths:
 *
 *   * **Currencies never mix (ADR-004).** Each currency is projected on its own
 *     pace against its own cap. A rupee pace never spends a euro budget.
 *   * **Minor units and bigint throughout.** The projection is
 *     `spent × totalDays ÷ elapsedDays`, all bigint, truncating — no float, no
 *     rounding a projection into a promise of precision it does not have.
 *   * **`today` is passed in, never read from a clock.** The answer depends on
 *     the trip's timezone, which this package does not know.
 */

import type { Budget } from './budget';
import { daysBetween } from './timeline';

export interface Forecast {
  readonly currency: string;
  readonly spentMinor: bigint;
  /** Days counted so far, from the start through today (clamped to the end). ≥1. */
  readonly elapsedDays: number;
  /** The trip's full length in days. */
  readonly totalDays: number;
  /** spent ÷ elapsedDays, truncating. */
  readonly dailyBurnMinor: bigint;
  /** spent × totalDays ÷ elapsedDays. Equals spent once the trip has ended. */
  readonly projectedTotalMinor: bigint;
  /** The cap for this currency, or null when nothing is budgeted in it. */
  readonly capMinor: bigint | null;
  /** projectedTotal − cap (signed; positive is over), or null with no cap. */
  readonly projectedOverrunMinor: bigint | null;
  /** projectedTotal ≤ cap, or null with no cap. */
  readonly onTrack: boolean | null;
  /** True once today is past the trip's end: the projection is now the actual. */
  readonly ended: boolean;
}

export interface ForecastInput {
  readonly spentByCurrency: Readonly<Record<string, bigint>>;
  /** A single-currency cap, if the trip has one. Only its currency gets a cap. */
  readonly budget?: Budget | null;
  /** `YYYY-MM-DD` in the trip's timezone. */
  readonly today: string;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
}

/**
 * One forecast per currency, or an empty list when a forecast makes no sense:
 * the trip has no dates, or it has not started yet (nothing has elapsed to
 * extrapolate from). A currency that is budgeted but not yet spent still gets a
 * row, so an untouched budget shows as on track rather than vanishing.
 */
export function forecast(input: ForecastInput): Forecast[] {
  const { startDate, endDate, today } = input;
  if (!startDate || !endDate || endDate < startDate) return [];
  if (today < startDate) return []; // not started; no pace to read yet

  const ended = today > endDate;
  const effectiveToday = ended ? endDate : today;
  const elapsedDays = Math.max(1, daysBetween(startDate, effectiveToday).length);
  const totalDays = Math.max(elapsedDays, daysBetween(startDate, endDate).length);

  const budgetCurrency = input.budget ? input.budget.currency.toUpperCase() : null;

  const currencies = new Set<string>();
  for (const key of Object.keys(input.spentByCurrency)) currencies.add(key.toUpperCase());
  if (budgetCurrency) currencies.add(budgetCurrency);

  const elapsed = BigInt(elapsedDays);
  const total = BigInt(totalDays);

  const out: Forecast[] = [];
  for (const currency of currencies) {
    const spent = input.spentByCurrency[currency] ?? 0n;
    const projected = (spent * total) / elapsed; // bigint, truncating
    const capMinor = budgetCurrency === currency ? (input.budget?.amountMinor ?? null) : null;

    out.push({
      currency,
      spentMinor: spent,
      elapsedDays,
      totalDays,
      dailyBurnMinor: spent / elapsed,
      projectedTotalMinor: projected,
      capMinor,
      projectedOverrunMinor: capMinor === null ? null : projected - capMinor,
      onTrack: capMinor === null ? null : projected <= capMinor,
      ended,
    });
  }

  return out.sort((a, b) => a.currency.localeCompare(b.currency));
}
