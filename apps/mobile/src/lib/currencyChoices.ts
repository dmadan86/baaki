/**
 * The currencies the app offers in the small mobile pickers.
 *
 * This is deliberately not every ISO-4217 code: the mobile sheets need a short,
 * tappable list. It must, however, cover the currencies the rest of the app can
 * already recognise from travel speech/SMS so a traveller is not told in prose
 * that Vietnam works and then blocked from choosing VND in the trip-rate UI.
 */
export const COMMON_CURRENCIES = [
  'INR',
  'USD',
  'EUR',
  'GBP',
  'AED',
  'SGD',
  'AUD',
  'THB',
  'VND',
  'IDR',
  'MYR',
  'PHP',
  'JPY',
  'KRW',
  'LKR',
  'NPR',
] as const;

/**
 * The group currency is the unit every pinned trip rate converts into. Changing
 * it while any rate is pinned would silently reinterpret every stored numerator
 * and denominator as a rate into a different currency. That is the same class of
 * ledger lie as changing it after expenses exist, so the row becomes read-only
 * once either facts or rates depend on it.
 */
export function settlementCurrencyLocked(expenseCount: number, tripRateCount: number): boolean {
  return expenseCount > 0 || tripRateCount > 0;
}

/** Only an admin can pick the settlement currency, and only before anything
 *  else has made that currency part of the group's arithmetic. */
export function canEditSettlementCurrency(
  isAdmin: boolean,
  expenseCount: number,
  tripRateCount: number,
): boolean {
  return isAdmin && !settlementCurrencyLocked(expenseCount, tripRateCount);
}
