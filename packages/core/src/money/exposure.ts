/**
 * Currency exposure: "You paid ₹12,400, €90 and ฿2,100."
 *
 * On a trip that touched three currencies, the one number people want that the
 * app deliberately refuses to give is a single total — because the rate that
 * would make one exists only in the moment somebody accepts it (ADR-004). So
 * exposure is the honest alternative: what you are *out*, in each currency, side
 * by side. Nothing is converted; nothing is added.
 *
 * The ordering is by nominal minor units, largest first — a rough "biggest
 * first" for the eye, not a claim that ₹12,400 is "more" than €90. Ties break by
 * currency code so the line reads the same on every device. Zero and negative
 * balances are dropped: a currency you are not out anything in is not exposure.
 */

export interface CurrencyExposure {
  readonly currency: string;
  /** What was paid in this currency, in its own minor units. Always positive. */
  readonly amountMinor: bigint;
}

/**
 * A per-currency paid map reduced to an ordered exposure list. The input is
 * whatever "paid" means to the caller — what one member fronted, or the group's
 * whole outlay — this only sorts and filters it, it never mixes currencies.
 */
export function currencyExposure(
  paidByCurrency: Readonly<Record<string, bigint>>,
): CurrencyExposure[] {
  const out: CurrencyExposure[] = [];
  for (const [currency, amount] of Object.entries(paidByCurrency)) {
    if (amount > 0n) out.push({ currency: currency.toUpperCase(), amountMinor: amount });
  }
  return out.sort((a, b) => {
    if (a.amountMinor !== b.amountMinor) return a.amountMinor > b.amountMinor ? -1 : 1;
    return a.currency.localeCompare(b.currency);
  });
}
