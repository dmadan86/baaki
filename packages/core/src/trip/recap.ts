/**
 * Trip recap: the trip, once it is over, in the few numbers people repeat.
 *
 * "We spent ₹84,000, mostly on stays, the biggest single bill was the
 * houseboat, and Ravi fronted the most." Every one of those is already in the
 * ledger; this reduces it to the headline.
 *
 * The two rules the rest of the trip maths obeys hold here too:
 *
 *   * **Currencies never mix (ADR-004).** There is no single "total" — a trip
 *     billed in rupees and baht has two totals, and the recap carries a block
 *     per currency. A screen may lead with the biggest block; it must not add
 *     them up.
 *   * **Minor units and bigint throughout.** The daily average is the only
 *     division, taken with truncating bigint division — no float touches money.
 *
 * Multi-payer is respected: `payers` is a list, so "who paid most" counts every
 * hand that actually fronted cash, not just the first name on the expense.
 */

import { daysBetween } from './timeline';

/** An expense, reduced to what a recap needs of it. */
export interface RecapExpense {
  readonly id: string;
  /** `YYYY-MM-DD`, in the trip's timezone. */
  readonly date: string;
  readonly description: string;
  /** null is "uncategorised" and is left out of the top-category race. */
  readonly category: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** Who fronted this expense, in minor units. Sums to the amount by convention. */
  readonly payers: readonly { readonly member: string; readonly amountMinor: bigint }[];
}

export interface CategoryTotal {
  readonly category: string;
  readonly totalMinor: bigint;
}

export interface BiggestExpense {
  readonly id: string;
  readonly description: string;
  readonly amountMinor: bigint;
}

export interface TopPayer {
  readonly member: string;
  readonly paidMinor: bigint;
}

export interface CurrencyRecap {
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly expenseCount: number;
  /** Highest-spending real category, or null when nothing was categorised. */
  readonly topCategory: CategoryTotal | null;
  readonly biggestExpense: BiggestExpense | null;
  readonly topPayer: TopPayer | null;
  /** Days the average is spread over: the trip's length if known, else days
   * that actually had spend. Never zero. */
  readonly dayCount: number;
  /** total / dayCount, truncating. */
  readonly dailyAverageMinor: bigint;
}

export interface Recap {
  /** One block per currency, largest total first (nominal, not converted). */
  readonly byCurrency: readonly CurrencyRecap[];
  readonly expenseCount: number;
  readonly firstDay: string | null;
  readonly lastDay: string | null;
}

export interface RecapInput {
  readonly expenses: readonly RecapExpense[];
  /** The trip's dates, if it has them: fixes the average's denominator. */
  readonly startDate?: string | null;
  readonly endDate?: string | null;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Reduce a ledger to its recap. Deterministic: ties (equal category totals,
 * equal payer totals) break by name/id so the same trip recaps the same way on
 * every device.
 */
export function recap(input: RecapInput): Recap {
  const currencies = new Map<
    string,
    {
      total: bigint;
      count: number;
      categories: Map<string, bigint>;
      biggest: BiggestExpense | null;
      payers: Map<string, bigint>;
      days: Set<string>;
    }
  >();

  let firstDay: string | null = null;
  let lastDay: string | null = null;

  for (const expense of input.expenses) {
    if (firstDay === null || expense.date < firstDay) firstDay = expense.date;
    if (lastDay === null || expense.date > lastDay) lastDay = expense.date;

    const currency = expense.currency.toUpperCase();
    const block = currencies.get(currency) ?? {
      total: 0n,
      count: 0,
      categories: new Map<string, bigint>(),
      biggest: null,
      payers: new Map<string, bigint>(),
      days: new Set<string>(),
    };

    block.total += expense.amountMinor;
    block.count += 1;
    block.days.add(expense.date);

    if (expense.category) {
      block.categories.set(
        expense.category,
        (block.categories.get(expense.category) ?? 0n) + expense.amountMinor,
      );
    }

    // Strictly greater keeps the first-seen expense on a tie, which — because
    // input order is the caller's, not guaranteed — we make deterministic by
    // also comparing the id below.
    if (
      block.biggest === null ||
      expense.amountMinor > block.biggest.amountMinor ||
      (expense.amountMinor === block.biggest.amountMinor && expense.id < block.biggest.id)
    ) {
      block.biggest = {
        id: expense.id,
        description: expense.description,
        amountMinor: expense.amountMinor,
      };
    }

    for (const payer of expense.payers) {
      if (payer.amountMinor === 0n) continue;
      block.payers.set(payer.member, (block.payers.get(payer.member) ?? 0n) + payer.amountMinor);
    }

    currencies.set(currency, block);
  }

  const tripDays =
    input.startDate && input.endDate ? daysBetween(input.startDate, input.endDate).length : 0;

  const byCurrency: CurrencyRecap[] = [...currencies.entries()].map(([currency, block]) => {
    let topCategory: CategoryTotal | null = null;
    for (const [category, total] of block.categories) {
      if (
        topCategory === null ||
        total > topCategory.totalMinor ||
        (total === topCategory.totalMinor && category < topCategory.category)
      ) {
        topCategory = { category, totalMinor: total };
      }
    }

    let topPayer: TopPayer | null = null;
    for (const [member, paid] of block.payers) {
      if (
        topPayer === null ||
        paid > topPayer.paidMinor ||
        (paid === topPayer.paidMinor && member < topPayer.member)
      ) {
        topPayer = { member, paidMinor: paid };
      }
    }

    // Prefer the trip's real length so a two-day trip with spend on one day
    // still averages over two. Never divide by zero.
    const dayCount = max(BigInt(tripDays), BigInt(block.days.size)) || 1n;

    return {
      currency,
      totalMinor: block.total,
      expenseCount: block.count,
      topCategory,
      biggestExpense: block.biggest,
      topPayer,
      dayCount: Number(dayCount),
      dailyAverageMinor: block.total / dayCount,
    };
  });

  byCurrency.sort((a, b) => {
    if (a.totalMinor !== b.totalMinor) return a.totalMinor > b.totalMinor ? -1 : 1;
    return a.currency.localeCompare(b.currency);
  });

  return {
    byCurrency,
    expenseCount: input.expenses.length,
    firstDay,
    lastDay,
  };
}
