/**
 * Adding up balances across groups, which is only ever legal within a currency.
 *
 * ADR-004 keeps per-currency balances and states the zero-sum invariant per
 * currency; the TDR is blunter still — "currencies are never summed or
 * converted". Adding a dollar balance to a rupee one produces a figure that is
 * not money in any currency, and whatever symbol gets printed in front of it is
 * a lie about an amount somebody is deciding whether to pay.
 *
 * Lives in @waves/core because both the phone's home screen and the web
 * dashboard total the same way, and a total that disagreed between them would
 * be the one bug a shared package exists to prevent (TDR §1).
 */

/** What is owed and owing in one currency. Never a mixture of several. */
export interface CurrencyTotals {
  readonly currency: string;
  readonly net: bigint;
  readonly owed: bigint;
  readonly owing: bigint;
}

/**
 * Group balances totalled per currency, and never across them.
 *
 * Ordered largest first by absolute net, so a caller can lead with the currency
 * the person has most at stake in and count the rest.
 */
export function totalsByCurrency(
  balances: Iterable<readonly [currency: string, balance: bigint]>,
): CurrencyTotals[] {
  const byCurrency = new Map<string, { owed: bigint; owing: bigint }>();

  for (const [currency, balance] of balances) {
    const running = byCurrency.get(currency) ?? { owed: 0n, owing: 0n };
    if (balance > 0n) running.owed += balance;
    else running.owing += -balance;
    byCurrency.set(currency, running);
  }

  const abs = (value: bigint): bigint => (value < 0n ? -value : value);

  return [...byCurrency]
    .map(([currency, { owed, owing }]) => ({ currency, net: owed - owing, owed, owing }))
    .sort((a, b) => {
      const left = abs(a.net);
      const right = abs(b.net);
      // Alphabetical only as a tie-break, so the order never depends on which
      // group happened to sync first.
      if (left === right) return a.currency.localeCompare(b.currency);
      return right > left ? 1 : -1;
    });
}
