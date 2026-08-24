/**
 * Trip budgets: a ceiling somebody set, measured against what the ledger says
 * they actually spent.
 *
 * The same two rules the rest of the trip maths obeys hold here:
 *
 *   * **Currencies never mix (ADR-004).** A budget is a number in one currency.
 *     It is measured against spend in *that* currency and no other — a euro cap
 *     is not "used up" by a rupee dinner. Spend in other currencies is real and
 *     is reported separately; it just does not count against this cap, because
 *     the rate to make it count is one nobody agreed.
 *   * **Minor units and bigint throughout.** No Number touches an amount. The
 *     one place a ratio is taken — for a progress bar's width — is the only
 *     float, and it is a display value, never money.
 *
 * "Spent" is never stored. A member's spend is the sum of their expense shares:
 * what the split says is theirs. That is the number a personal budget is a
 * ceiling on — "how much of this trip is mine to pay for" — not what they
 * happened to front at the counter.
 */

/** One expense, reduced to what a budget needs: its currency and who owes what. */
export interface SharedExpense {
  readonly currency: string;
  /** member id → their share of this expense, in minor units. */
  readonly shares: Readonly<Record<string, bigint>>;
}

/** One expense, reduced to what a category budget needs: its category, currency
 *  and full amount (a category cap measures the group's spend, not one share). */
export interface CategorisedExpense {
  readonly category: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
}

/** A ceiling: an amount in one currency. */
export interface Budget {
  readonly amountMinor: bigint;
  readonly currency: string;
}

/**
 * One budget's standing. `ratio` is clamped to [0, 1] for a bar's width;
 * `over` is the flag that says the true figure ran past it, because a bar that
 * stops at full cannot show by how much. `remainingMinor` is the honest
 * signed gap — negative when over.
 */
export interface BudgetProgress {
  readonly currency: string;
  readonly capMinor: bigint;
  readonly spentMinor: bigint;
  readonly remainingMinor: bigint;
  readonly ratio: number;
  readonly over: boolean;
}

/**
 * Every member's spend, per currency, from the expense shares.
 *
 * A member with no shares is simply absent from the map — nobody's spend is
 * invented as a zero, the same way `plannedByCurrency` never invents one.
 */
export function spendByMember(
  expenses: readonly SharedExpense[],
): Map<string, Record<string, bigint>> {
  const out = new Map<string, Record<string, bigint>>();
  for (const expense of expenses) {
    const currency = expense.currency.toUpperCase();
    for (const [member, share] of Object.entries(expense.shares)) {
      if (share === 0n) continue;
      const row = out.get(member) ?? {};
      row[currency] = (row[currency] ?? 0n) + share;
      out.set(member, row);
    }
  }
  return out;
}

/**
 * Group spend per category, per currency (ADR-004: never mixed). Uncategorised
 * spend (a null category) is left out — a cap is only ever set on a named
 * category, so folding "Other" in would measure it against nothing.
 *
 * Unlike `spendByMember`, this sums the whole expense amount, not a share: a
 * category cap is the group's ceiling on food/stays/transport, not one person's.
 */
export function spendByCategory(
  expenses: readonly CategorisedExpense[],
): Map<string, Record<string, bigint>> {
  const out = new Map<string, Record<string, bigint>>();
  for (const expense of expenses) {
    if (!expense.category) continue;
    const currency = expense.currency.toUpperCase();
    const row = out.get(expense.category) ?? {};
    row[currency] = (row[currency] ?? 0n) + expense.amountMinor;
    out.set(expense.category, row);
  }
  return out;
}

/**
 * A budget against a spend map, in the budget's own currency. Returns null when
 * there is no budget to measure — "unset" is not the same as a cap of zero, and
 * must not draw a bar.
 */
export function budgetProgress(
  budget: Budget | null | undefined,
  spentByCurrency: Readonly<Record<string, bigint>> | undefined,
): BudgetProgress | null {
  if (!budget) return null;
  const currency = budget.currency.toUpperCase();
  const cap = budget.amountMinor;
  const spent = spentByCurrency?.[currency] ?? 0n;
  const over = spent > cap;
  return {
    currency,
    capMinor: cap,
    spentMinor: spent,
    remainingMinor: cap - spent,
    ratio: ratioOf(spent, cap),
    over,
  };
}

/**
 * A bar's fill, in [0, 1]. A zero cap that has any spend against it is full; a
 * zero cap with nothing spent is empty. Everything else is spent/cap, capped at
 * full — `over` carries the overflow, not the bar.
 */
function ratioOf(spent: bigint, cap: bigint): number {
  if (cap <= 0n) return spent > 0n ? 1 : 0;
  if (spent >= cap) return 1;
  if (spent <= 0n) return 0;
  // Scaled integer division keeps this exact for amounts a double would round.
  return Number((spent * 10_000n) / cap) / 10_000;
}
