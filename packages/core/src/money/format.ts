/**
 * Display formatting. The ONLY place in this package where a Number is
 * produced from an amount, and it never feeds back into arithmetic.
 * TDR §11: all money/date formatting is locale-aware.
 */

import { minorUnitExponent, minorUnitScale, type CurrencyCode } from './currency';
import { toMajorString, type Money } from './money';

export type Locale = 'en-IN' | 'ta-IN' | 'hi-IN' | (string & {});

export interface FormatOptions {
  locale?: Locale;
  /** Drop the fraction when the amount is a whole unit (₹420 instead of ₹420.00). */
  compactFraction?: boolean;
  /** Render the sign explicitly (+₹420). Negatives always show their sign. */
  signDisplay?: 'auto' | 'always' | 'never';
}

const DEFAULT_LOCALE: Locale = 'en-IN';

export function format(amount: Money, options: FormatOptions = {}): string {
  return parts(amount, options)
    .map((part) => part.value)
    .join('');
}

/**
 * A formatted amount split at the decimal point.
 *
 * The paise are worth less than the rupees and should not shout as loudly, so
 * the display renders them fainter — but only the locale knows where the split
 * falls. `₹1,517.53`, `$1,517.53` and `1 517,53 €` disagree about the
 * separator and about which side the symbol sits on, and searching the string
 * for a '.' gets two of those three wrong.
 */
export interface MoneyParts {
  /** Sign, symbol and whole units — everything before the decimal separator. */
  readonly lead: string;
  /** The separator and the minor units (`.53`), or `''` when none are shown. */
  readonly fraction: string;
  /** Whatever the locale prints after them, such as a trailing `€`. */
  readonly trail: string;
  /** The three joined — identical to `format()` on the same arguments. */
  readonly text: string;
}

export function formatParts(amount: Money, options: FormatOptions = {}): MoneyParts {
  const lead: string[] = [];
  const fraction: string[] = [];
  const trail: string[] = [];

  // Everything from the decimal separator onwards is the fraction, until
  // something that is plainly not part of the number turns up again.
  let seen: 'lead' | 'fraction' | 'trail' = 'lead';
  for (const part of parts(amount, options)) {
    if (part.type === 'decimal') seen = 'fraction';
    else if (seen === 'fraction' && part.type !== 'fraction') seen = 'trail';

    (seen === 'lead' ? lead : seen === 'fraction' ? fraction : trail).push(part.value);
  }

  const joined = [lead.join(''), fraction.join(''), trail.join('')] as const;
  return { lead: joined[0], fraction: joined[1], trail: joined[2], text: joined.join('') };
}

function parts(amount: Money, options: FormatOptions): Intl.NumberFormatPart[] {
  const { locale = DEFAULT_LOCALE, compactFraction = false, signDisplay = 'auto' } = options;
  const exponent = minorUnitExponent(amount.currency);
  const isWhole = amount.minor % minorUnitScale(amount.currency) === 0n;
  const fractionDigits = compactFraction && isWhole ? 0 : exponent;

  const magnitude = signDisplay === 'never' && amount.minor < 0n ? -amount.minor : amount.minor;

  // Number() is safe here: a value large enough to lose precision (>9e15 minor
  // units ≈ ₹90 trillion) is not a real split, and display is not arithmetic.
  const asNumber = Number(toMajorString({ minor: magnitude, currency: amount.currency }));

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    signDisplay: signDisplay === 'never' ? 'auto' : signDisplay,
  }).formatToParts(asNumber);
}

/** Just the currency symbol for the locale ("₹", "$"). */
export function currencySymbol(currency: CurrencyCode, locale: Locale = DEFAULT_LOCALE): string {
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? currency;
}

export enum BalanceDirection {
  OwedToYou = 'owed_to_you',
  YouOwe = 'you_owe',
  Settled = 'settled',
}

export function balanceDirection(minor: bigint): BalanceDirection {
  if (minor > 0n) return BalanceDirection.OwedToYou;
  if (minor < 0n) return BalanceDirection.YouOwe;
  return BalanceDirection.Settled;
}

/**
 * TDR §11 accessibility: money values carry a spoken label, never a bare
 * number. Copy lives in notifications/copy.ts so it stays translatable.
 */
export function moneyAccessibilityLabel(
  amount: Money,
  direction: BalanceDirection,
  strings: { owedToYou: string; youOwe: string; settled: string },
  options: FormatOptions = {},
): string {
  const rendered = format(
    { minor: amount.minor < 0n ? -amount.minor : amount.minor, currency: amount.currency },
    options,
  );
  switch (direction) {
    case BalanceDirection.OwedToYou:
      return strings.owedToYou.replace('{amount}', rendered);
    case BalanceDirection.YouOwe:
      return strings.youOwe.replace('{amount}', rendered);
    case BalanceDirection.Settled:
      return strings.settled;
  }
}
